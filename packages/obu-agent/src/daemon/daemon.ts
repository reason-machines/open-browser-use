// WS-C: the daemon core. Owns the session manager, the per-tab runtimes and
// mutexes, the browser backend, and the full JSON-RPC handler table. Page
// operations are delegated to WS-D (snapshot/) and WS-E (actions/, wait/,
// screenshot/) through the PageContext seam.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  CDP_DENYLIST_PREFIXES,
  CONTRACT_VERSION,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  METHODS,
  type ActParams,
  type ActResult,
  type CdpParams,
  type DaemonInfoResult,
  type EvaluateParams,
  type MethodName,
  type NavigateParams,
  type ScreenshotParams,
  type ScreenshotResult,
  type SessionCloseParams,
  type SessionEventsParams,
  type SessionHeartbeatParams,
  type SessionOpenParams,
  type Settled,
  type SnapshotMode,
  type SnapshotParams,
  type SnapshotResult,
  type SystemEvent,
  type TabId,
  type TabInfo,
  type TabsAttachParams,
  type TabsCloseParams,
  type TabsListParams,
  type TabsOpenParams,
  type TabsSelectParams,
  type TabsTransferParams,
  type WaitParams,
  type WaitResult,
} from "../contract.js";
import { ObuError, notImplemented } from "../errors.js";
import type { PageContext } from "../seams.js";
import type { BackendEvent, BackendOwner, BrowserBackend } from "../cdp/backend.js";
import { isTabGoneError } from "../cdp/backend.js";
import { TabRuntime, type DialogDecision } from "../cdp/page.js";
import { SessionManager, type EventInput } from "../session/manager.js";
import { KeyedMutex } from "../session/mutex.js";
import { reconcileOnStart, startLeaseSweeper, type LeaseClock } from "../lease/index.js";
import type { Store, SessionRow } from "../store/index.js";
import type { HandlerTable } from "../server/rpc.js";
import { takeSnapshot as wsdTakeSnapshot } from "../snapshot/index.js";
import { act as wseAct } from "../actions/index.js";
import { deliverSystemEvent, performActionAndWait as wsePerformActionAndWait, takePendingDialogAction } from "../wait/index.js";
import { configureDownloads, type PendingDownload } from "../files/index.js";
import { screenshot as wseScreenshot } from "../screenshot/index.js";
import { INJECTED_BUNDLE_SOURCE, INJECTED_VERSION } from "../injected/index.js";

export const DAEMON_VERSION = "0.1.0";

/** `wait{for: download|popup|dialog}` also matches unclaimed events this recent. */
export const WAIT_LOOKBACK_MS = 10_000;

/** Page-operation modules (WS-D / WS-E). Injectable so tests can mock them. */
export interface PageModules {
  takeSnapshot(page: PageContext, params: SnapshotParams): Promise<Omit<SnapshotResult, "events">>;
  act(page: PageContext, params: ActParams): Promise<Omit<ActResult, "events" | "snapshot">>;
  performActionAndWait(page: PageContext, action: () => Promise<void>): Promise<Settled>;
  screenshot(page: PageContext, params: ScreenshotParams): Promise<ScreenshotResult>;
}

export interface DaemonOptions {
  profile: string;
  backend: BrowserBackend;
  store: Store;
  artifactRoot: string;
  clock?: LeaseClock;
  leaseTtlMs?: number;
  sweepMs?: number;
  startedAt?: number;
  modules?: Partial<PageModules>;
  /** Override the injected bundle (tests). '' = none. */
  bundle?: { source: string; version: string };
  /** Reconnect delay after the backend drops. */
  reconnectMs?: number;
  log?: (line: string) => void;
}

const PLACEHOLDER_BUNDLE = /^\/\* obu injected bundle: not built/;

export class Daemon {
  readonly sessions: SessionManager;
  readonly backend: BrowserBackend;
  readonly profile: string;
  readonly startedAt: number;
  readonly modules: PageModules;
  #mutex = new KeyedMutex<TabId>();
  #runtimes = new Map<TabId, TabRuntime>();
  #dialogDecisions = new Map<TabId, DialogDecision[]>();
  /** Browser-level downloads (chrome.downloads via the extension), by backend id. */
  #downloads = new Map<string, { downloadId: number; tabId?: TabId; url: string; path: string; finishedAt?: number; state: "in_progress" | "complete" | "interrupted" }>();
  #downloadWaiters = new Set<() => void>();
  /** Per session: seq of the last event each `wait{for}` returned (so one event satisfies one wait). */
  #claimedSeq = new Map<string, Partial<Record<WaitParams["for"], number>>>();
  #nextDownloadId = 1;
  #artifactRoot: string;
  #bundle: { source: string; version: string };
  #stopSweeper: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #opts: DaemonOptions;

  constructor(opts: DaemonOptions) {
    this.#opts = opts;
    this.profile = opts.profile;
    this.backend = opts.backend;
    this.startedAt = opts.startedAt ?? Date.now();
    this.#artifactRoot = opts.artifactRoot;
    const source = opts.bundle?.source ?? (PLACEHOLDER_BUNDLE.test(INJECTED_BUNDLE_SOURCE) ? "" : INJECTED_BUNDLE_SOURCE);
    this.#bundle = { source, version: opts.bundle?.version ?? INJECTED_VERSION };
    this.modules = {
      takeSnapshot: opts.modules?.takeSnapshot ?? wsdTakeSnapshot,
      act: opts.modules?.act ?? wseAct,
      performActionAndWait: opts.modules?.performActionAndWait ?? wsePerformActionAndWait,
      screenshot: opts.modules?.screenshot ?? wseScreenshot,
    };
    this.sessions = new SessionManager({
      store: opts.store,
      profile: opts.profile,
      clock: opts.clock,
      leaseTtlMs: opts.leaseTtlMs,
      closer: {
        closeOwned: (session, tabId, { guard }) => this.#closeOwned(session, tabId, guard),
        releaseBorrowed: async (session, tabId) => {
          this.#forgetRuntime(tabId);
          await this.backend.releaseTab(this.ownerOf(session.id), tabId);
        },
        finalizeRoot: async (session, kept) => {
          if (this.backend.finalize && this.backend.isConnected()) await this.backend.finalize(this.ownerOf(session.id), kept);
        },
        forgetTab: (tabId) => this.#forgetRuntime(tabId),
      },
    });
  }

  /** Connect the backend (best effort), reconcile (I5), start the lease sweeper. */
  async start(): Promise<void> {
    this.#unsubscribe = this.backend.onEvent((event) => this.#onBackendEvent(event));
    // WS-E's per-tab tracker sees Page.downloadWillBegin but (through the
    // extension) never the final path: resolve it from chrome.downloads.
    configureDownloads({ resolvePath: (d) => this.#resolveDownloadPath(d) });
    await this.backend.connect().catch((error) => {
      this.#log(`browser backend not connected yet: ${(error as Error).message}`);
      this.#scheduleReconnect();
    });
    const { finalized } = await reconcileOnStart(this.sessions);
    if (finalized.length) this.#log(`reconciled ${finalized.length} expired session(s) from a previous run`);
    this.#stopSweeper = startLeaseSweeper(this.sessions, this.#opts.sweepMs ?? 1_000);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopSweeper?.();
    this.#unsubscribe?.();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    for (const runtime of this.#runtimes.values()) runtime.dispose();
    this.#runtimes.clear();
    await this.backend.close().catch(() => undefined);
    this.sessions.store.close();
  }

  /** Backend owner for a session: one extension session (tab group) per ROOT session. */
  ownerOf(sessionId: string): BackendOwner {
    const root = this.sessions.root(sessionId);
    return { key: `obu-agent:${root.id}`, label: root.label ?? root.id };
  }

  // -------------------------------------------------------------------------
  // Backend events → session events

  #onBackendEvent(event: BackendEvent): void {
    switch (event.type) {
      case "tab_closed": {
        this.#forgetRuntime(event.tabId);
        const dropped = this.sessions.dropTab(event.tabId);
        if (dropped) this.sessions.emit(dropped.sessionId, { type: "tab_closed", tabId: event.tabId, reason: "user", activeTabId: dropped.activeTabId });
        break;
      }
      case "lease_revoked": {
        this.#forgetRuntime(event.tabId);
        const dropped = this.sessions.dropTab(event.tabId);
        if (dropped) this.sessions.emit(dropped.sessionId, { type: "lease_revoked", tabId: event.tabId, reason: event.reason });
        break;
      }
      case "popup": {
        const opener = this.sessions.store.ownerOf(event.openerTabId);
        if (!opener || this.sessions.store.ownerOf(event.tabId)) break;
        this.sessions.addTab(opener.sessionId, { tabId: event.tabId, targetId: event.targetId ?? null, ownership: "owned" }, false);
        const tab: TabInfo = { tabId: event.tabId, url: event.url ?? "", title: "", ownership: "owned", active: false, sessionId: opener.sessionId };
        this.sessions.emit(opener.sessionId, { type: "popup_opened", tabId: event.tabId, tab, openerTabId: event.openerTabId });
        break;
      }
      case "download":
        this.#onDownload(event);
        break;
      case "owner_expired": {
        // The extension's lease backstop finalized a session we still hold.
        for (const tabId of event.closedTabIds) {
          this.#forgetRuntime(tabId);
          const dropped = this.sessions.dropTab(tabId);
          if (dropped) this.sessions.emit(dropped.sessionId, { type: "tab_closed", tabId, reason: "lease_expired", activeTabId: dropped.activeTabId });
        }
        break;
      }
      case "disconnected":
        for (const runtime of this.#runtimes.values()) runtime.dispose();
        this.#runtimes.clear();
        this.#log(`browser backend disconnected: ${event.error ?? "unknown"}`);
        this.#scheduleReconnect();
        break;
    }
  }

  #capabilities() {
    return this.backend.capabilities?.() ?? { tabEvents: false, downloads: false, closeTab: false };
  }

  #onDownload(event: Extract<BackendEvent, { type: "download" }>): void {
    this.#log(`download ${event.id} ${event.status} tab=${event.tabId ?? "?"} ${event.url} -> ${event.path}`);
    let entry = this.#downloads.get(event.id);
    const firstSight = !entry;
    if (!entry) {
      entry = { downloadId: this.#nextDownloadId++, tabId: event.tabId, url: event.url, path: event.path, state: "in_progress" };
      this.#downloads.set(event.id, entry);
      // Bounded memory: forget the oldest finished downloads.
      if (this.#downloads.size > 200) {
        for (const [id, old] of this.#downloads) {
          if (old.state !== "in_progress") {
            this.#downloads.delete(id);
            break;
          }
        }
      }
    }
    entry.path = event.path || entry.path;
    entry.tabId ??= event.tabId;
    const owner = entry.tabId !== undefined ? this.sessions.store.ownerOf(entry.tabId) : undefined;
    const info = (): import("../contract.js").DownloadInfo => ({
      downloadId: entry!.downloadId,
      url: entry!.url,
      path: entry!.path,
      ...(event.mime ? { mime: event.mime } : {}),
      ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
      state: entry!.state,
      ...(entry!.tabId !== undefined ? { tabId: entry!.tabId } : {}),
    });
    if (firstSight && owner && this.#capabilities().downloads) {
      this.sessions.emit(owner.sessionId, { type: "download_started", tabId: entry.tabId, download: info() });
    }
    if (event.status === "complete" || event.status === "interrupted") {
      if (entry.state !== "in_progress") return;
      entry.state = event.status;
      entry.finishedAt = Date.now();
      if (owner && this.#capabilities().downloads) {
        this.sessions.emit(owner.sessionId, { type: "download_finished", tabId: entry.tabId, download: info() });
      }
      for (const wake of [...this.#downloadWaiters]) wake();
    }
  }

  /** Final path of a CDP-observed download, from the matching chrome.downloads item. */
  async #resolveDownloadPath(d: PendingDownload): Promise<string | undefined> {
    const match = () =>
      [...this.#downloads.values()].find(
        (entry) => entry.state === "complete" && entry.url === d.url && (entry.tabId === undefined || entry.tabId === d.tabId) && (entry.finishedAt ?? 0) >= d.startedAt - 1_000,
      );
    const found = match();
    if (found) return found.path;
    return new Promise((resolve) => {
      const wake = () => {
        const hit = match();
        if (hit) done(hit.path);
      };
      const done = (path: string | undefined) => {
        clearTimeout(timer);
        this.#downloadWaiters.delete(wake);
        resolve(path);
      };
      const timer = setTimeout(() => done(undefined), 10_000);
      timer.unref();
      this.#downloadWaiters.add(wake);
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#stopped || this.backend.isConnected()) return;
      this.backend.connect().then(
        () => this.#log("browser backend reconnected"),
        () => this.#scheduleReconnect(),
      );
    }, this.#opts.reconnectMs ?? 2_000);
    this.#reconnectTimer.unref();
  }

  // -------------------------------------------------------------------------
  // Tab runtimes

  #runtime(tabId: TabId): TabRuntime {
    let runtime = this.#runtimes.get(tabId);
    if (runtime && !runtime.disposed) return runtime;
    const row = this.sessions.store.ownerOf(tabId);
    runtime = new TabRuntime({
      backend: this.backend,
      tabId,
      targetId: row?.targetId ?? undefined,
      owner: () => {
        const owner = this.sessions.store.ownerOf(tabId);
        if (!owner) throw new ObuError("tab_not_owned", `tab ${tabId} is no longer owned by any session`, { tabId });
        return this.ownerOf(owner.sessionId);
      },
      ownership: () => this.sessions.store.ownerOf(tabId)?.ownership ?? "owned",
      bundleSource: () => this.#bundle.source,
      bundleVersion: () => this.#bundle.version,
      emit: (event) => {
        const owner = this.sessions.store.ownerOf(tabId);
        const stamped = owner ? this.sessions.emit(owner.sessionId, event as EventInput) : undefined;
        if (stamped && runtime) deliverSystemEvent(runtime.cdp, stamped);
      },
      // Daemon-level `wait{for:'dialog', dialogAction}` first, then WS-E's queue.
      takeDialogDecision: () => this.#dialogDecisions.get(tabId)?.shift() ?? (runtime ? takePendingDialogAction(runtime.cdp) : undefined),
    });
    this.#runtimes.set(tabId, runtime);
    return runtime;
  }

  #forgetRuntime(tabId: TabId): void {
    this.#runtimes.get(tabId)?.dispose();
    this.#runtimes.delete(tabId);
    this.#dialogDecisions.delete(tabId);
  }

  async #closeOwned(session: SessionRow, tabId: TabId, guard: boolean): Promise<boolean> {
    if (guard && this.backend.isConnected()) {
      const tab = await this.backend.getTab(tabId).catch(() => undefined);
      if (tab?.active && tab.windowFocused !== false) return false; // the user is looking at it: leave it open
    }
    this.#forgetRuntime(tabId);
    await this.backend.closeTab(this.ownerOf(session.id), tabId);
    return true;
  }

  #artifactDir(sessionId: string): string {
    const dir = join(this.#artifactRoot, sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Run a page operation on (session, tab) under the tab mutex (I3).
   * `focus`: emulate focus for its duration (I7).
   */
  async #onPage<T>(
    sessionId: string,
    tabId: TabId | undefined,
    focus: boolean,
    treeKey: string | null,
    fn: (page: PageContext, runtime: TabRuntime, tab: TabId) => Promise<T>,
  ): Promise<T> {
    const row = this.sessions.resolveTab(sessionId, tabId);
    const runtime = this.#runtime(row.tabId);
    return this.#mutex.run(row.tabId, async () => {
      // Ownership may have changed while queued.
      this.sessions.resolveTab(sessionId, row.tabId);
      try {
        return await runtime.run(focus, async () => {
          const page = runtime.context(
            sessionId,
            this.#artifactDir(sessionId),
            treeKey ? this.sessions.previousTree(sessionId, treeKeyFor(row.tabId, treeKey)) : undefined,
            (event) => {
              // With browser-level download events (extension), those are authoritative;
              // drop WS-E's CDP-derived duplicates.
              if ((event.type === "download_started" || event.type === "download_finished") && this.#capabilities().downloads) return;
              const stamped = this.sessions.emit(sessionId, { ...event, tabId: (event as { tabId?: TabId }).tabId ?? row.tabId } as EventInput);
              if (stamped) deliverSystemEvent(runtime.cdp, stamped);
            },
          );
          return await fn(page, runtime, row.tabId);
        });
      } catch (error) {
        if (isTabGoneError(error)) {
          this.#forgetRuntime(row.tabId);
          const dropped = this.sessions.dropTab(row.tabId);
          if (dropped) this.sessions.emit(dropped.sessionId, { type: "tab_closed", tabId: row.tabId, reason: "crash", activeTabId: dropped.activeTabId });
          throw new ObuError("no_active_tab", `tab ${row.tabId} was closed or crashed; open or select another tab`, { tabId: row.tabId });
        }
        throw error;
      }
    });
  }

  #withEvents<T extends object>(sessionId: string, result: T): T & { events: SystemEvent[] } {
    return { ...result, events: this.sessions.drain(sessionId) };
  }

  /** Snapshot after a mutating call, per SnapshotMode. Never throws: failures become warnings. */
  async #snapshotAfter(
    page: PageContext,
    sessionId: string,
    tabId: TabId,
    mode: SnapshotMode,
    warnings: string[],
  ): Promise<{ tree?: string; diff?: string; url: string; title: string } | undefined> {
    if (mode === "none") return undefined;
    const key = treeKeyFor(tabId, "full");
    const previous = this.sessions.previousTree(sessionId, key);
    try {
      const snap = await this.modules.takeSnapshot({ ...page, previousTree: previous }, { sessionId, tabId, maxChars: DEFAULT_SNAPSHOT_MAX_CHARS });
      this.sessions.setPreviousTree(sessionId, key, snap.tree);
      warnings.push(...(snap.warnings ?? []));
      if (mode === "tree" || previous === undefined) return { tree: snap.tree, url: snap.url, title: snap.title };
      return { diff: snap.diff, url: snap.url, title: snap.title };
    } catch (error) {
      warnings.push(`snapshot after action failed: ${(error as Error).message}`);
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Navigation (WS-C owns navigate; settle comes from WS-E)

  async #navigate(page: PageContext, runtime: TabRuntime, params: NavigateParams, warnings: string[]): Promise<Settled> {
    const started = Date.now();
    let sameDocument = false;
    const action = async () => {
      if (params.url) {
        const result = await runtime.send<any>("Page.navigate", { url: params.url }, { timeoutMs: 30_000 });
        if (result?.errorText) warnings.push(`navigation to ${params.url} failed: ${result.errorText}`);
        sameDocument = !result?.loaderId;
      } else if (params.op === "reload") {
        await runtime.send("Page.reload", {}, { timeoutMs: 30_000 });
      } else if (params.op === "back" || params.op === "forward") {
        const history = await runtime.send<any>("Page.getNavigationHistory", {});
        const entry = history.entries[history.currentIndex + (params.op === "back" ? -1 : 1)];
        if (!entry) throw new ObuError("invalid_params", `cannot go ${params.op}: no history entry`);
        await runtime.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { timeoutMs: 30_000 });
      } else {
        throw new ObuError("invalid_params", "navigate needs url or op ('back' | 'forward' | 'reload')");
      }
    };
    const waitUntil = params.waitUntil ?? "settled";
    if (waitUntil === "settled") return this.modules.performActionAndWait(page, action);
    if (waitUntil === "none") {
      await action();
      return { kind: "none", ms: Date.now() - started };
    }
    const eventName = waitUntil === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
    let resolveEvent!: () => void;
    const fired = new Promise<void>((resolve) => (resolveEvent = resolve));
    const offs = [
      runtime.on(eventName, (_params, sessionId) => {
        if (!sessionId) resolveEvent();
      }),
      // Back/forward served from the bfcache fires no load event.
      runtime.on("Page.frameNavigated", (params, sessionId) => {
        if (!sessionId && !params.frame?.parentId && params.type === "BackForwardCacheRestore") resolveEvent();
      }),
      // History entries of the same document (pushState) don't load either.
      runtime.on("Page.navigatedWithinDocument", (_params, sessionId) => {
        if (!sessionId && params.op) resolveEvent();
      }),
    ];
    const off = () => offs.forEach((unsubscribe) => unsubscribe());
    try {
      await action();
      if (!sameDocument) {
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 30_000).unref());
        if ((await Promise.race([fired, timeout])) === "timeout") {
          return { kind: "nav", ms: Date.now() - started, warning: `${eventName} did not fire within 30 s` };
        }
      }
    } finally {
      off();
    }
    return { kind: sameDocument ? "spa" : "nav", ms: Date.now() - started };
  }

  async #pageInfo(runtime: TabRuntime): Promise<{ url: string; title: string }> {
    try {
      const value = (await runtime.evaluate("[location.href, document.title]", "isolated", false)) as [string, string];
      return { url: value[0], title: value[1] };
    } catch {
      const tab = await this.backend.getTab(runtime.tabId).catch(() => undefined);
      return { url: tab?.url ?? "", title: tab?.title ?? "" };
    }
  }

  // -------------------------------------------------------------------------
  // Waits

  async #wait(params: WaitParams): Promise<WaitResult> {
    const sessionId = params.sessionId;
    const timeoutMs = Math.max(0, Math.min(params.timeoutMs ?? 30_000, 120_000));
    // Event waits also match events from the last few seconds that no earlier
    // wait claimed: a fast download/popup often lands before the agent's
    // `wait` call (e.g. right after the click that started it). A dialog with
    // a dialogAction is about the NEXT dialog, so it only looks forward.
    const claimed = this.#claimedSeq.get(sessionId) ?? {};
    const lookBack = params.for === "dialog" && params.dialogAction ? this.sessions.lastSeq(sessionId) : await this.#recentFloor(sessionId);
    const afterSeq = Math.max(claimed[params.for] ?? 0, lookBack);
    const claim = (event: SystemEvent | undefined) => {
      if (event) this.#claimedSeq.set(sessionId, { ...(this.#claimedSeq.get(sessionId) ?? {}), [params.for]: event.seq });
      return event;
    };
    const forEvent = async (predicate: (event: SystemEvent) => boolean): Promise<SystemEvent | undefined> => {
      // Keep the lease alive during long waits.
      const keepAlive = setInterval(() => this.sessions.touch(sessionId), 10_000);
      keepAlive.unref();
      try {
        return claim(await this.sessions.waitForEvent(sessionId, predicate, timeoutMs, afterSeq));
      } finally {
        clearInterval(keepAlive);
      }
    };
    switch (params.for) {
      case "dialog": {
        const row = this.sessions.resolveTab(sessionId, params.tabId);
        if (params.dialogAction) {
          const queue = this.#dialogDecisions.get(row.tabId) ?? [];
          queue.push(params.dialogAction);
          this.#dialogDecisions.set(row.tabId, queue);
        }
        const event = await forEvent((e) => e.type === "dialog" && e.tabId === row.tabId);
        if (!event && params.dialogAction) {
          const queue = this.#dialogDecisions.get(row.tabId);
          const index = queue?.indexOf(params.dialogAction) ?? -1;
          if (queue && index >= 0) queue.splice(index, 1);
        }
        return event ? { ok: true, event } : { ok: false, warnings: [`no dialog within ${timeoutMs} ms`] };
      }
      case "popup": {
        const event = await forEvent((e) => e.type === "popup_opened");
        return event && event.type === "popup_opened" ? { ok: true, event, tab: event.tab } : { ok: false, warnings: [`no popup within ${timeoutMs} ms`] };
      }
      case "download": {
        const event = await forEvent((e) => e.type === "download_finished");
        return event && event.type === "download_finished"
          ? { ok: true, event, download: event.download }
          : { ok: false, warnings: [`no finished download within ${timeoutMs} ms`] };
      }
      case "settled": {
        const settled = await this.#onPage(sessionId, params.tabId, false, null, (page) => this.modules.performActionAndWait(page, async () => {}));
        return { ok: !settled.warning, ...(settled.warning ? { warnings: [settled.warning] } : {}) };
      }
      case "selector":
      case "text":
      case "url": {
        const probe = buildProbe(params);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const ok = await this.#onPage(sessionId, params.tabId, false, null, (_page, runtime) => runtime.evaluate(probe, "isolated", false)).catch((error) => {
            if (error instanceof ObuError && (error.code === "no_active_tab" || error.code === "tab_not_owned" || error.code === "unknown_session")) throw error;
            return false;
          });
          if (ok === true) return { ok: true };
          if (Date.now() >= deadline) return { ok: false, warnings: [`${params.for} condition not met within ${timeoutMs} ms`] };
          this.sessions.touch(sessionId);
          await sleep(100);
        }
      }
      default:
        throw new ObuError("invalid_params", `wait.for must be one of download|popup|dialog|selector|text|url|settled`);
    }
  }

  /** Seq of the newest event older than the wait look-back window. */
  async #recentFloor(sessionId: string): Promise<number> {
    const { events } = await this.sessions.events(sessionId, 0, 0);
    const cutoff = Date.now() - WAIT_LOOKBACK_MS;
    let floor = 0;
    for (const event of events) if (event.at < cutoff) floor = event.seq;
    return floor;
  }

  // -------------------------------------------------------------------------
  // Handler table

  handlers(): HandlerTable {
    const table: HandlerTable = {};
    for (const method of METHODS) table[method] = () => {
      throw notImplemented(method, "round 2");
    };
    const s = this.sessions;

    table["daemon.info"] = (): DaemonInfoResult => ({
      contractVersion: CONTRACT_VERSION,
      daemonVersion: DAEMON_VERSION,
      profile: this.profile,
      pid: process.pid,
      startedAt: this.startedAt,
      extension: { connected: this.backend.isConnected(), ...(this.backend.version() ? { version: this.backend.version() } : {}) },
      sessions: s.list().length,
    });

    table["session.open"] = (params) => s.open(params as SessionOpenParams);

    table["session.heartbeat"] = (params) => {
      const row = s.require((params as SessionHeartbeatParams).sessionId);
      return { expiresAt: row.expiresAt };
    };

    table["session.close"] = async (params) => {
      const p = params as SessionCloseParams;
      s.require(p.sessionId);
      this.#claimedSeq.delete(p.sessionId);
      return s.close(p.sessionId, p.keep ?? [], "agent");
    };

    table["session.events"] = async (params) => {
      const p = params as SessionEventsParams;
      s.require(p.sessionId);
      return s.events(p.sessionId, p.afterSeq ?? 0, p.waitMs ?? 0);
    };

    table["tabs.list"] = async (params) => {
      const p = params as TabsListParams;
      s.require(p.sessionId);
      const scope = p.scope ?? "mine";
      if (scope === "browser") {
        const tabs = await this.backend.listBrowserTabs();
        return {
          tabs: tabs.map((tab) => {
            const owner = s.store.ownerOf(tab.tabId);
            const mine = owner?.sessionId === p.sessionId;
            return {
              tabId: tab.tabId,
              url: tab.url,
              title: tab.title,
              ...(mine ? { ownership: owner!.ownership, active: owner!.active, sessionId: p.sessionId } : {}),
              ...(tab.groupTitle ? { groupTitle: tab.groupTitle } : {}),
              ...(tab.lastAccessed ? { lastAccessed: tab.lastAccessed } : {}),
            } satisfies TabInfo;
          }),
          activeTabId: s.activeTabId(p.sessionId),
        };
      }
      const ids = scope === "mine+children" ? s.descendantsOf(p.sessionId) : [p.sessionId];
      const tabs: TabInfo[] = [];
      for (const id of ids) {
        const rows = s.tabInfos(id);
        await Promise.all(
          rows.map(async (row) => {
            const live = await this.backend.getTab(row.tabId).catch(() => undefined);
            if (live) {
              row.url = live.url;
              row.title = live.title;
            }
          }),
        );
        tabs.push(...rows);
      }
      return { tabs, activeTabId: s.activeTabId(p.sessionId) };
    };

    table["tabs.open"] = async (params) => {
      const p = params as TabsOpenParams;
      s.require(p.sessionId);
      if (typeof p.url !== "string" || !p.url) throw new ObuError("invalid_params", "tabs.open requires url");
      const owner = this.ownerOf(p.sessionId);
      // Created blank so the attach sequence (bundle, metrics) is in place before the first document loads.
      const created = await this.backend.createTab(owner, "about:blank");
      s.addTab(p.sessionId, { tabId: created.tabId, targetId: created.targetId ?? null, ownership: "owned" }, p.makeActive ?? true);
      const warnings: string[] = [];
      try {
        const result = await this.#onPage(p.sessionId, created.tabId, true, null, async (page, runtime, tabId) => {
          warnings.push(...runtime.setupWarnings.splice(0));
          if (!runtime.targetId) {
            const info = await runtime.send<any>("Target.getTargetInfo", {}).catch(() => undefined);
            if (info?.targetInfo?.targetId) runtime.targetId = info.targetInfo.targetId;
          }
          const settled = p.url === "about:blank" ? { kind: "none" as const, ms: 0 } : await this.#navigate(page, runtime, { sessionId: p.sessionId, url: p.url }, warnings);
          const snapshot = await this.#snapshotAfter(page, p.sessionId, tabId, p.snapshot ?? "none", warnings);
          const info = snapshot ?? (await this.#pageInfo(runtime));
          return { tabId, targetId: runtime.targetId, url: info.url, title: info.title, ok: true as const, settled, ...(snapshot ? { snapshot } : {}) };
        });
        return this.#withEvents(p.sessionId, { ...result, ...(warnings.length ? { warnings } : {}) });
      } catch (error) {
        if (error instanceof ObuError && error.code === "no_active_tab") throw error;
        // Keep the tab (the agent can retry on it) but report the failure.
        throw error;
      }
    };

    table["tabs.attach"] = async (params) => {
      const p = params as TabsAttachParams;
      s.require(p.sessionId);
      if (typeof p.tabId !== "number") throw new ObuError("invalid_params", "tabs.attach requires tabId");
      const owner = s.store.ownerOf(p.tabId);
      if (owner && owner.sessionId !== p.sessionId) throw new ObuError("tab_not_owned", `tab ${p.tabId} is already used by session ${owner.sessionId}`, { tabId: p.tabId });
      if (!owner) {
        const tab = await this.backend.claimTab(this.ownerOf(p.sessionId), p.tabId);
        s.addTab(p.sessionId, { tabId: tab.tabId, targetId: tab.targetId ?? null, ownership: "borrowed" }, true);
      } else {
        s.select(p.sessionId, p.tabId);
      }
      const live = await this.backend.getTab(p.tabId).catch(() => undefined);
      const info = s.tabInfos(p.sessionId).find((tab) => tab.tabId === p.tabId)!;
      return { tab: { ...info, url: live?.url ?? info.url, title: live?.title ?? info.title } };
    };

    table["tabs.select"] = (params) => {
      const p = params as TabsSelectParams;
      s.require(p.sessionId);
      return { activeTabId: s.select(p.sessionId, p.tabId) };
    };

    table["tabs.close"] = async (params) => {
      const p = params as TabsCloseParams;
      s.require(p.sessionId);
      const row = s.resolveTab(p.sessionId, p.tabId);
      await this.#mutex.run(row.tabId, async () => {
        this.#forgetRuntime(row.tabId);
        if (row.ownership === "borrowed") await this.backend.releaseTab(this.ownerOf(p.sessionId), row.tabId);
        else await this.backend.closeTab(this.ownerOf(p.sessionId), row.tabId);
      });
      const dropped = s.dropTab(row.tabId);
      return { activeTabId: dropped?.activeTabId };
    };

    table["tabs.transfer"] = async (params) => {
      const p = params as TabsTransferParams;
      s.require(p.sessionId);
      s.require(p.toSessionId);
      const row = s.resolveTab(p.sessionId, p.tabId);
      // Wait for in-flight operations on the tab before handing it over.
      const activeTabId = await this.#mutex.run(row.tabId, async () => s.transfer(p.sessionId, p.tabId, p.toSessionId));
      return { activeTabId };
    };

    table.snapshot = async (params) => {
      const p = params as SnapshotParams;
      s.require(p.sessionId);
      const scoped = Boolean(p.ref || p.selector);
      const key = p.interactive ? "interactive" : "full";
      const result = await this.#onPage(p.sessionId, p.tabId, true, scoped ? null : key, async (page, runtime, tabId) => {
        const snap = await this.modules.takeSnapshot(page, { ...p, tabId, maxChars: p.maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS });
        if (!scoped) this.sessions.setPreviousTree(p.sessionId, treeKeyFor(tabId, key), snap.tree);
        const setup = runtime.setupWarnings.splice(0);
        return setup.length ? { ...snap, warnings: [...(snap.warnings ?? []), ...setup] } : snap;
      });
      return this.#withEvents(p.sessionId, result);
    };

    table.act = async (params) => {
      const p = params as ActParams;
      s.require(p.sessionId);
      const result = await this.#onPage(p.sessionId, p.tabId, true, null, async (page, runtime, tabId) => {
        const acted = await this.modules.act(page, p);
        const warnings = [...(acted.warnings ?? []), ...runtime.setupWarnings.splice(0)];
        const snapshot = await this.#snapshotAfter(page, p.sessionId, tabId, p.snapshot ?? "diff", warnings);
        return { ...acted, ...(snapshot ? { snapshot } : {}), ...(warnings.length ? { warnings } : {}) };
      });
      return this.#withEvents(p.sessionId, result);
    };

    table.navigate = async (params) => {
      const p = params as NavigateParams;
      s.require(p.sessionId);
      const result = await this.#onPage(p.sessionId, p.tabId, true, null, async (page, runtime, tabId) => {
        const warnings = runtime.setupWarnings.splice(0);
        const settled = await this.#navigate(page, runtime, p, warnings);
        const snapshot = await this.#snapshotAfter(page, p.sessionId, tabId, p.snapshot ?? "none", warnings);
        return { ok: true as const, settled, ...(snapshot ? { snapshot } : {}), ...(warnings.length ? { warnings } : {}) };
      });
      return this.#withEvents(p.sessionId, result);
    };

    table.screenshot = async (params) => {
      const p = params as ScreenshotParams;
      s.require(p.sessionId);
      return this.#onPage(p.sessionId, p.tabId, false, null, (page) => this.modules.screenshot(page, p));
    };

    table.evaluate = async (params) => {
      const p = params as EvaluateParams;
      s.require(p.sessionId);
      if (typeof p.expression !== "string") throw new ObuError("invalid_params", "evaluate requires expression");
      const world = p.world ?? "isolated";
      if (world !== "isolated" && world !== "page") throw new ObuError("invalid_params", "world must be 'isolated' or 'page'");
      const value = await this.#onPage(p.sessionId, p.tabId, false, null, (_page, runtime) => runtime.evaluate(p.expression, world, p.awaitPromise ?? false));
      return this.#withEvents(p.sessionId, { value });
    };

    table.cdp = async (params) => {
      const p = params as CdpParams;
      s.require(p.sessionId);
      if (typeof p.method !== "string") throw new ObuError("invalid_params", "cdp requires method");
      if (CDP_DENYLIST_PREFIXES.some((prefix) => p.method === prefix || p.method.startsWith(prefix))) {
        throw new ObuError("cdp_denied", `CDP method ${p.method} is not allowed through the cdp escape hatch (denied: ${CDP_DENYLIST_PREFIXES.join(", ")})`);
      }
      const result = await this.#onPage(p.sessionId, p.tabId, false, null, async (_page, runtime) => {
        const sessionId = p.frameRef ? await runtime.sessionForFrameRef(p.frameRef) : undefined;
        return runtime.send(p.method, p.params ?? {}, { sessionId, timeoutMs: p.timeoutMs });
      });
      return { result };
    };

    table.wait = async (params) => {
      const p = params as WaitParams;
      s.require(p.sessionId);
      return this.#wait(p);
    };

    return table;
  }

  #log(line: string): void {
    this.#opts.log?.(line);
  }
}

function treeKeyFor(tabId: TabId, key: string): TabId {
  // Store per-(tab, mode) trees in the same map: interactive trees use negative keys.
  return key === "interactive" ? -tabId - 1 : tabId;
}

function buildProbe(params: WaitParams): string {
  if (params.for === "selector") {
    if (!params.selector) throw new ObuError("invalid_params", "wait for selector requires selector");
    return `(() => { try { const el = document.querySelector(${JSON.stringify(params.selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; } catch { return false; } })()`;
  }
  if (params.for === "text") {
    if (!params.text) throw new ObuError("invalid_params", "wait for text requires text");
    return `(document.body ? document.body.innerText : "").includes(${JSON.stringify(params.text)})`;
  }
  if (!params.url) throw new ObuError("invalid_params", "wait for url requires url (glob or substring)");
  const glob = params.url;
  if (/[*?]/.test(glob)) {
    const regex = "^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, ".") + "$";
    return `new RegExp(${JSON.stringify(regex)}).test(location.href)`;
  }
  return `location.href.includes(${JSON.stringify(glob)})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { MethodName };
