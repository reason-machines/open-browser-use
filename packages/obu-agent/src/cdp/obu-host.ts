// WS-C: ObuHostBackend — the production path. Talks to the OBU native host
// socket (registry `/tmp/<brand>-browser-use/active.json`) with the existing
// length-prefixed JSON-RPC protocol: createTab / attach / executeCdp /
// claimUserTab / finalizeTabs / getTabs / getUserTabs, events as `onCDPEvent`.
//
// Ownership truth lives in the daemon (D0.3). At the extension level we use
// ONE extension session (= one tab group) per ROOT daemon session; children
// act on tabs in the root's group and the daemon enforces I2. The owner key
// is chosen by the session manager.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection, type Socket } from "node:net";
import { endianness } from "node:os";
import type { TabId } from "../contract.js";
import { ObuError } from "../errors.js";
import { Emitter, type BackendCapabilities, type BackendEvent, type BackendOwner, type BackendTab, type BrowserBackend, type SendOptions } from "./backend.js";

const HEADER_BYTES = 4;

export interface ObuHostOptions {
  /** Explicit socket path; otherwise OBU_RELAY_SOCKET, then the registry dirs. */
  socketPath?: string;
  /** Relay token file; otherwise OBU_RELAY_TOKEN_PATH / active.json tokenPath / <socketDir>/relay.token. */
  tokenPath?: string;
  /** Registry dirs to search for active.json (brand first). */
  registryDirs?: string[];
  defaultTimeoutMs?: number;
  /** How often to look for tabs the user closed (the extension does not forward debugger detach). */
  pollMs?: number;
}

/**
 * Where the native-host relay listens and the token it wants (WS-B: first
 * frame `{"auth":"<token>"}` unless OBU_RELAY_AUTH=uid). Re-resolved on every
 * (re)connect because the host rewrites active.json when it restarts.
 */
export function resolveRelay(options: ObuHostOptions = {}): { socketPath: string; tokenPath?: string } {
  const envToken = process.env.OBU_RELAY_TOKEN_PATH;
  if (options.socketPath) return { socketPath: options.socketPath, tokenPath: options.tokenPath ?? envToken ?? siblingToken(options.socketPath) };
  // Supervised by the host: it tells us the relay socket directly.
  const envSocket = process.env.OBU_RELAY_SOCKET;
  if (envSocket && existsSync(envSocket)) return { socketPath: envSocket, tokenPath: envToken ?? siblingToken(envSocket) };
  const brand = process.env.OBU_BRAND ?? "reason";
  const dirs = options.registryDirs ?? [
    ...(process.env.OBU_SOCKET_DIR ? [process.env.OBU_SOCKET_DIR] : []),
    `/tmp/${brand}-browser-use`,
    "/tmp/reason-browser-use",
    "/tmp/open-browser-use",
  ];
  for (const dir of dirs) {
    const registry = `${dir}/active.json`;
    if (!existsSync(registry)) continue;
    try {
      const { socketPath, tokenPath } = JSON.parse(readFileSync(registry, "utf8")) as { socketPath?: string; tokenPath?: string };
      if (socketPath && existsSync(socketPath)) return { socketPath, tokenPath: envToken ?? tokenPath ?? siblingToken(socketPath) };
    } catch {
      // try the next registry
    }
  }
  throw new ObuError("extension_disconnected", "Open Browser Use native host is not running (no active.json registry). Open Chrome with the extension installed.");
}

/** Back-compat helper: just the socket path. */
export function resolveObuSocket(options: ObuHostOptions = {}): string {
  return resolveRelay(options).socketPath;
}

function siblingToken(socketPath: string): string | undefined {
  const candidate = `${dirname(socketPath)}/relay.token`;
  return existsSync(candidate) ? candidate : undefined;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class ObuHostBackend implements BrowserBackend {
  readonly kind = "obu-host" as const;
  #socket: Socket | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map<string, Pending>();
  #events = new Emitter<BackendEvent>();
  #attached = new Set<TabId>();
  #owners = new Map<TabId, BackendOwner>();
  #version: string | undefined;
  /** Extension wire v2 features (`getInfo().capabilities.wire`); empty = legacy extension. */
  #wire = new Set<string>();
  /** Chrome profile id of the extension (`route.profileId` on every request). */
  #profileId: string | undefined;
  #poll: NodeJS.Timeout | null = null;
  readonly #timeoutMs: number;

  constructor(private readonly options: ObuHostOptions = {}) {
    this.#timeoutMs = options.defaultTimeoutMs ?? 15_000;
  }

  async connect(): Promise<void> {
    if (this.#socket) return;
    const { socketPath: path, tokenPath } = resolveRelay(this.options);
    const socket = createConnection(path);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#onClose("native host socket closed"));
    socket.on("error", (error) => this.#onClose(error.message));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    this.#socket = socket;
    if (process.env.OBU_RELAY_AUTH !== "uid" && tokenPath && existsSync(tokenPath)) {
      // WS-B relay auth: first frame. Relays that don't require it drop it.
      socket.write(encodeFrame({ auth: readFileSync(tokenPath, "utf8").trim() }));
    }
    const info = (await this.#request("getInfo", { session_id: "obu-agent" }).catch(() => undefined)) as any;
    this.#version = info?.version ?? info?.extensionVersion ?? info?.metadata?.version;
    this.#wire = new Set(Array.isArray(info?.capabilities?.wire) ? info.capabilities.wire.map(String) : []);
    this.#profileId = typeof info?.metadata?.profileId === "string" ? info.metadata.profileId : undefined;
    // Wire v2 pushes tabClosed / leaseRevoked / popupOpened: no polling.
    const pollMs = this.#wire.has("lease-events") ? 0 : (this.options.pollMs ?? 3_000);
    if (pollMs > 0) {
      this.#poll = setInterval(() => void this.#pollClosed(), pollMs);
      this.#poll.unref();
    }
  }

  isConnected(): boolean {
    return this.#socket !== null;
  }

  version(): string | undefined {
    return this.#version;
  }

  capabilities(): BackendCapabilities {
    return {
      tabEvents: this.#wire.has("lease-events"),
      downloads: this.#wire.has("download-correlation"),
      closeTab: this.#wire.has("close-guard"),
    };
  }

  /** Extension wire v2 feature flags (diagnostics). */
  wireFeatures(): string[] {
    return [...this.#wire];
  }

  async createTab(owner: BackendOwner, url: string): Promise<BackendTab> {
    const direct = this.#wire.has("implicit-attach") && url && url !== "about:blank";
    const tab = (await this.#request("createTab", { ...this.#params(owner), ...(direct ? { url } : {}) })) as {
      id: number;
      url?: string;
      title?: string;
      targetId?: string;
    };
    this.#owners.set(tab.id, owner);
    if (owner.label) await this.#request("nameSession", { ...this.#params(owner), name: `${owner.label} · Reason` }).catch(() => undefined);
    if (url && url !== "about:blank" && !direct) {
      await this.attach(owner, tab.id);
      await this.send(owner, tab.id, "Page.navigate", { url });
    }
    return { tabId: tab.id, ...(tab.targetId ? { targetId: tab.targetId } : {}), url: url || tab.url || "about:blank", title: tab.title ?? "" };
  }

  async closeTab(owner: BackendOwner, tabId: TabId): Promise<void> {
    if (this.#wire.has("close-guard")) {
      // Guarded close: a tab the user is looking at is released, not closed.
      await this.#request("closeTab", { ...this.#params(owner), tabId }).catch(() => undefined);
      this.#forget(tabId);
      return;
    }
    // Legacy extension: Page.close through the debugger closes the tab.
    await this.attach(owner, tabId).catch(() => undefined);
    await this.send(owner, tabId, "Page.close", {}).catch(() => undefined);
    this.#forget(tabId);
  }

  async claimTab(owner: BackendOwner, tabId: TabId): Promise<BackendTab> {
    const tab = (await this.#request("claimUserTab", { ...this.#params(owner), tabId })) as { id: number; url?: string; title?: string };
    this.#owners.set(tab.id, owner);
    return { tabId: tab.id, url: tab.url ?? "", title: tab.title ?? "" };
  }

  async releaseTab(owner: BackendOwner, tabId: TabId): Promise<void> {
    // finalizeTabs releases (ungroups) user tabs that are not kept. Keep every
    // other tab of the owner as handoff so nothing else changes.
    const tabs = (await this.#request("getTabs", this.#params(owner)).catch(() => [])) as { id: number }[];
    const keep = tabs.filter((tab) => tab.id !== tabId).map((tab) => ({ tabId: tab.id, status: "handoff" }));
    await this.#request("finalizeTabs", { ...this.#params(owner), keep });
    // finalize detaches every tab; re-attach lazily.
    for (const tab of tabs) this.#attached.delete(tab.id);
    this.#forget(tabId);
  }

  /** Finalize a whole owner (root session close): closes agent tabs not kept, releases user tabs. */
  async finalize(owner: BackendOwner, keep: { tabId: TabId; status: "handoff" | "deliverable" }[]): Promise<void> {
    await this.#request("finalizeTabs", { ...this.#params(owner), keep });
    for (const [tabId, tabOwner] of this.#owners) {
      if (tabOwner.key !== owner.key) continue;
      this.#attached.delete(tabId);
      if (!keep.some((entry) => entry.tabId === tabId)) this.#owners.delete(tabId);
    }
  }

  async getTab(tabId: TabId): Promise<BackendTab | undefined> {
    const owner = this.#owners.get(tabId);
    if (owner) {
      const tabs = (await this.#request("getTabs", this.#params(owner)).catch(() => undefined)) as any[] | undefined;
      const tab = tabs?.find((candidate) => candidate.id === tabId);
      if (tab) return { tabId, url: tab.url ?? "", title: tab.title ?? "", active: tab.active };
      if (tabs) return undefined;
    }
    return (await this.listBrowserTabs()).find((tab) => tab.tabId === tabId);
  }

  async listBrowserTabs(): Promise<BackendTab[]> {
    const tabs = (await this.#request("getUserTabs", { session_id: "obu-agent-readonly" })) as any[];
    return tabs.map((tab) => ({
      tabId: tab.id,
      url: tab.url ?? "",
      title: tab.title ?? "",
      groupTitle: tab.tabGroup,
      lastAccessed: tab.lastOpened ? Date.parse(tab.lastOpened) : undefined,
    }));
  }

  async attach(owner: BackendOwner, tabId: TabId): Promise<void> {
    if (this.#attached.has(tabId)) return;
    await this.#request("attach", { ...this.#params(owner), tabId });
    this.#attached.add(tabId);
    this.#owners.set(tabId, owner);
    // Wire v2 announces fresh attachments itself (`debuggerAttached`); an
    // idempotent re-attach must not wipe the tab's CDP setup.
    if (!this.#wire.has("implicit-attach")) this.#events.emit({ type: "attached", tabId });
  }

  async send<T>(owner: BackendOwner, tabId: TabId, method: string, params: Record<string, unknown> = {}, opts: SendOptions = {}): Promise<T> {
    await this.attach(owner, tabId);
    const target: Record<string, unknown> = { tabId };
    if (opts.sessionId) target.sessionId = opts.sessionId;
    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    try {
      return (await this.#request(
        "executeCdp",
        { ...this.#params(owner), target, method, commandParams: params, timeoutMs },
        timeoutMs + 1_000,
      )) as T;
    } catch (error) {
      if (/Debugger unattached|not attached/i.test(String((error as Error).message))) {
        this.#attached.delete(tabId);
        await this.attach(owner, tabId);
        return (await this.#request("executeCdp", { ...this.#params(owner), target, method, commandParams: params, timeoutMs }, timeoutMs + 1_000)) as T;
      }
      throw error;
    }
  }

  onEvent(handler: (event: BackendEvent) => void): () => void {
    return this.#events.on(handler);
  }

  async close(): Promise<void> {
    if (this.#poll) clearInterval(this.#poll);
    this.#poll = null;
    this.#socket?.end();
    this.#socket = null;
  }

  // -------------------------------------------------------------------------

  #params(owner: BackendOwner): Record<string, unknown> {
    return {
      session_id: owner.key,
      turn_id: "obu-agent",
      ...(owner.label ? { label: owner.label } : {}),
      // Guards against a host fronting another Chrome profile (profile_mismatch).
      ...(this.#profileId && this.#wire.has("route") ? { route: { profileId: this.#profileId } } : {}),
    };
  }

  #forget(tabId: TabId): void {
    this.#attached.delete(tabId);
    this.#owners.delete(tabId);
  }

  async #pollClosed(): Promise<void> {
    if (!this.#socket || this.#owners.size === 0) return;
    const byOwner = new Map<string, { owner: BackendOwner; tabIds: TabId[] }>();
    for (const [tabId, owner] of this.#owners) {
      const entry = byOwner.get(owner.key) ?? { owner, tabIds: [] };
      entry.tabIds.push(tabId);
      byOwner.set(owner.key, entry);
    }
    for (const { owner, tabIds } of byOwner.values()) {
      const tabs = (await this.#request("getTabs", this.#params(owner)).catch(() => undefined)) as { id: number }[] | undefined;
      if (!tabs) continue;
      const live = new Set(tabs.map((tab) => tab.id));
      for (const tabId of tabIds) {
        if (live.has(tabId)) continue;
        // Gone from the group: closed by the user, or dragged out (revocation).
        const stillExists = await this.#tabExists(tabId);
        this.#forget(tabId);
        this.#events.emit(stillExists ? { type: "lease_revoked", tabId, reason: "dragged_out_of_group" } : { type: "tab_closed", tabId });
      }
    }
  }

  async #tabExists(tabId: TabId): Promise<boolean> {
    const tabs = await this.listBrowserTabs().catch(() => undefined);
    return tabs ? tabs.some((tab) => tab.tabId === tabId) : false;
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number = this.#timeoutMs): Promise<unknown> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new ObuError("extension_disconnected", "Open Browser Use native host is not connected"));
    const id = `a${this.#nextId++}`;
    const frame = encodeFrame({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ObuError("timeout", `${method} timed out after ${timeoutMs} ms`, { stage: "host" }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      socket.write(frame);
    });
  }

  #onData(chunk: Buffer): void {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    while (this.#buffer.length >= HEADER_BYTES) {
      const length = endianness() === "LE" ? this.#buffer.readUInt32LE(0) : this.#buffer.readUInt32BE(0);
      if (this.#buffer.length < HEADER_BYTES + length) return;
      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length);
      let message: any;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message: any): void {
    if (message.id === null && message.error?.data?.type === "unauthorized") {
      this.#onClose(`native host rejected the relay token: ${message.error.message ?? "unauthorized"}`);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error.message ?? `${pending.method} failed`)));
      else pending.resolve(message.result ?? null);
      return;
    }
    const params = message.params ?? {};
    switch (message.method) {
      case "onCDPEvent": {
        const source = params.source ?? {};
        if (typeof source.tabId !== "number") return;
        const sessionId = params.sessionId ?? source.sessionId;
        this.#events.emit({ type: "cdp", tabId: source.tabId, method: params.method, params: params.params ?? {}, ...(sessionId ? { sessionId } : {}) });
        return;
      }
      case "debuggerAttached":
        if (typeof params.tabId === "number") {
          this.#attached.add(params.tabId);
          this.#events.emit({ type: "attached", tabId: params.tabId });
        }
        return;
      case "debuggerDetached":
        if (typeof params.tabId === "number") {
          this.#attached.delete(params.tabId);
          this.#events.emit({ type: "detached", tabId: params.tabId, reason: String(params.reason ?? "detached") });
        }
        return;
      case "sessionExpired": {
        const closed: TabId[] = Array.isArray(params.closedTabIds) ? params.closedTabIds.filter((id: unknown) => typeof id === "number") : [];
        for (const tabId of closed) this.#forget(tabId);
        if (typeof params.sessionId === "string") this.#events.emit({ type: "owner_expired", ownerKey: params.sessionId, closedTabIds: closed });
        return;
      }
      case "onDownloadChange": {
        const status = params.status === "complete" ? "complete" : params.status === "started" ? "started" : params.status === "failed" || params.status === "canceled" || params.status === "interrupted" ? "interrupted" : "in_progress";
        this.#events.emit({
          type: "download",
          id: String(params.id ?? ""),
          ...(typeof params.tabId === "number" ? { tabId: params.tabId } : {}),
          url: String(params.url ?? ""),
          path: String(params.filename ?? ""),
          status,
          ...(typeof params.mime === "string" ? { mime: params.mime } : {}),
          ...(typeof params.totalBytes === "number" && params.totalBytes >= 0 ? { bytes: params.totalBytes } : {}),
        });
        return;
      }
      // Emitted by the WS-A extension; harmless no-ops against older builds.
      case "popupOpened":
        if (typeof params.tabId === "number" && typeof params.openerTabId === "number") {
          const owner = this.#owners.get(params.openerTabId);
          if (owner) this.#owners.set(params.tabId, owner);
          this.#events.emit({ type: "popup", tabId: params.tabId, openerTabId: params.openerTabId, url: params.url });
        }
        return;
      case "leaseRevoked":
        if (typeof params.tabId === "number") {
          this.#forget(params.tabId);
          const reason = params.reason === "user_closed" || params.reason === "user_took_over" ? params.reason : "dragged_out_of_group";
          this.#events.emit({ type: "lease_revoked", tabId: params.tabId, reason });
        }
        return;
      case "tabClosed":
        if (typeof params.tabId === "number") {
          this.#forget(params.tabId);
          this.#events.emit({ type: "tab_closed", tabId: params.tabId });
        }
        return;
    }
  }

  #onClose(reason: string): void {
    if (!this.#socket) return;
    this.#socket = null;
    this.#attached.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ObuError("extension_disconnected", reason));
    }
    this.#pending.clear();
    this.#events.emit({ type: "disconnected", error: reason });
  }
}

function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(HEADER_BYTES + payload.length);
  if (endianness() === "LE") frame.writeUInt32LE(payload.length, 0);
  else frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}
