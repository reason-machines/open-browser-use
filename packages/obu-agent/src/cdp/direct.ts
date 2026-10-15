// WS-C: DirectCdpBackend — talks to a Chrome started with
// --remote-debugging-port (Chrome for Testing in tests; round-2 fast mode).
// One browser websocket, flat sessions (Target.attachToTarget{flatten}).
// Tab ids are synthetic numbers mapped 1:1 to page targetIds.
import type { TabId } from "../contract.js";
import { ObuError } from "../errors.js";
import { Emitter, type BackendEvent, type BackendOwner, type BackendTab, type BrowserBackend, type SendOptions } from "./backend.js";

interface PendingCall {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface PageTarget {
  tabId: TabId;
  targetId: string;
  url: string;
  title: string;
  openerId?: string;
  /** Flat session of the page target (attached lazily). */
  sessionId?: string;
}

export interface DirectCdpOptions {
  /** http://127.0.0.1:<port> or ws://… browser endpoint. */
  endpoint: string;
  defaultTimeoutMs?: number;
}

export class DirectCdpBackend implements BrowserBackend {
  readonly kind = "direct" as const;
  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #events = new Emitter<BackendEvent>();
  #targets = new Map<string, PageTarget>(); // targetId -> page
  #byTab = new Map<TabId, PageTarget>();
  #bySession = new Map<string, { tabId: TabId; child: boolean }>(); // flat session -> tab
  #attaching = new Map<TabId, Promise<string>>();
  #nextTabId = 1;
  #version: string | undefined;
  #browserContextId: string | undefined;
  readonly #timeoutMs: number;

  constructor(private readonly options: DirectCdpOptions) {
    this.#timeoutMs = options.defaultTimeoutMs ?? 15_000;
  }

  async connect(): Promise<void> {
    if (this.#ws) return;
    let wsUrl = this.options.endpoint;
    if (wsUrl.startsWith("http")) {
      const response = await fetch(`${wsUrl.replace(/\/$/, "")}/json/version`);
      const info = (await response.json()) as { webSocketDebuggerUrl: string; Browser?: string };
      wsUrl = info.webSocketDebuggerUrl;
      this.#version = info.Browser;
    }
    const ws = new WebSocket(wsUrl);
    ws.addEventListener("message", (event) => this.#onMessage(String((event as MessageEvent).data)));
    ws.addEventListener("close", () => this.#onClose("browser websocket closed"));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true });
    });
    this.#ws = ws;
    await this.#call("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await this.#call("Target.getTargets", {});
    for (const info of targetInfos) if (info.type === "page") this.#trackTarget(info);
  }

  isConnected(): boolean {
    return this.#ws !== null;
  }

  version(): string | undefined {
    return this.#version;
  }

  async createTab(_owner: BackendOwner, url: string): Promise<BackendTab> {
    const { targetId } = await this.#call("Target.createTarget", {
      url: url || "about:blank",
      background: true,
      ...(this.#browserContextId ? { browserContextId: this.#browserContextId } : {}),
    });
    const page = this.#targets.get(targetId) ?? this.#trackTarget({ targetId, url, title: "", type: "page" });
    return toTab(page);
  }

  async closeTab(_owner: BackendOwner, tabId: TabId): Promise<void> {
    const page = this.#byTab.get(tabId);
    if (!page) return;
    await this.#call("Target.closeTarget", { targetId: page.targetId }).catch(() => undefined);
  }

  async claimTab(_owner: BackendOwner, tabId: TabId): Promise<BackendTab> {
    const page = this.#byTab.get(tabId);
    if (!page) throw new ObuError("invalid_params", `tab ${tabId} does not exist`, { tabId });
    return toTab(page);
  }

  async releaseTab(): Promise<void> {}

  async getTab(tabId: TabId): Promise<BackendTab | undefined> {
    const page = this.#byTab.get(tabId);
    return page ? toTab(page) : undefined;
  }

  async listBrowserTabs(): Promise<BackendTab[]> {
    return [...this.#byTab.values()].map(toTab);
  }

  async attach(_owner: BackendOwner, tabId: TabId): Promise<void> {
    await this.#sessionFor(tabId);
  }

  async send<T>(_owner: BackendOwner, tabId: TabId, method: string, params: Record<string, unknown> = {}, opts: SendOptions = {}): Promise<T> {
    const sessionId = opts.sessionId ?? (await this.#sessionFor(tabId));
    return (await this.#call(method, params, sessionId, opts.timeoutMs)) as T;
  }

  onEvent(handler: (event: BackendEvent) => void): () => void {
    return this.#events.on(handler);
  }

  async close(): Promise<void> {
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  /** Test helper: open a "user" tab that the daemon does not own (foreground). */
  async openUserTab(url: string): Promise<BackendTab> {
    const { targetId } = await this.#call("Target.createTarget", { url });
    const page = this.#targets.get(targetId) ?? this.#trackTarget({ targetId, url, title: "", type: "page" });
    return toTab(page);
  }

  // -------------------------------------------------------------------------

  async #sessionFor(tabId: TabId): Promise<string> {
    const page = this.#byTab.get(tabId);
    if (!page) throw new Error(`No tab with given id ${tabId}`);
    if (page.sessionId) return page.sessionId;
    let pending = this.#attaching.get(tabId);
    if (!pending) {
      pending = this.#call("Target.attachToTarget", { targetId: page.targetId, flatten: true }).then(({ sessionId }) => {
        page.sessionId = sessionId;
        this.#bySession.set(sessionId, { tabId, child: false });
        this.#events.emit({ type: "attached", tabId });
        return sessionId as string;
      });
      this.#attaching.set(tabId, pending);
      pending.finally(() => this.#attaching.delete(tabId)).catch(() => undefined);
    }
    return pending;
  }

  #trackTarget(info: { targetId: string; url: string; title: string; type: string; openerId?: string }): PageTarget {
    const existing = this.#targets.get(info.targetId);
    if (existing) {
      existing.url = info.url;
      existing.title = info.title;
      return existing;
    }
    const page: PageTarget = { tabId: this.#nextTabId++, targetId: info.targetId, url: info.url, title: info.title, openerId: info.openerId };
    this.#targets.set(info.targetId, page);
    this.#byTab.set(page.tabId, page);
    return page;
  }

  #call(method: string, params: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<any> {
    const ws = this.#ws;
    if (!ws) return Promise.reject(new ObuError("extension_disconnected", "browser is not connected"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ObuError("timeout", `CDP ${method} timed out`, { stage: "cdp" }));
      }, timeoutMs ?? this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  #onMessage(raw: string): void {
    const message = JSON.parse(raw) as { id?: number; result?: any; error?: { message: string }; method?: string; params?: any; sessionId?: string };
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (!message.method) return;
    const { method, params } = message;
    if (method === "Target.targetCreated" && params.targetInfo.type === "page") {
      const page = this.#trackTarget(params.targetInfo);
      const opener = params.targetInfo.openerId ? this.#targets.get(params.targetInfo.openerId) : undefined;
      if (opener) this.#events.emit({ type: "popup", tabId: page.tabId, openerTabId: opener.tabId, url: page.url, targetId: page.targetId });
      return;
    }
    if (method === "Target.targetInfoChanged" && params.targetInfo.type === "page") {
      this.#trackTarget(params.targetInfo);
      return;
    }
    if (method === "Target.targetDestroyed") {
      const page = this.#targets.get(params.targetId);
      if (!page) return;
      this.#targets.delete(page.targetId);
      this.#byTab.delete(page.tabId);
      if (page.sessionId) this.#bySession.delete(page.sessionId);
      this.#events.emit({ type: "tab_closed", tabId: page.tabId });
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const owner = this.#bySession.get(params.sessionId);
      this.#bySession.delete(params.sessionId);
      if (owner && !owner.child) {
        const page = this.#byTab.get(owner.tabId);
        if (page) page.sessionId = undefined;
      }
    }
    if (!message.sessionId) return;
    const owner = this.#bySession.get(message.sessionId);
    if (!owner) return;
    if (method === "Target.attachedToTarget") {
      // Child (OOPIF / worker) of an owned tab: route its events to the tab.
      this.#bySession.set(params.sessionId, { tabId: owner.tabId, child: true });
    }
    this.#events.emit({
      type: "cdp",
      tabId: owner.tabId,
      method,
      params,
      ...(owner.child ? { sessionId: message.sessionId } : {}),
    });
  }

  #onClose(reason: string): void {
    this.#ws = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ObuError("extension_disconnected", reason));
    }
    this.#pending.clear();
    this.#events.emit({ type: "disconnected", error: reason });
  }
}

function toTab(page: PageTarget): BackendTab {
  return { tabId: page.tabId, targetId: page.targetId, url: page.url, title: page.title };
}
