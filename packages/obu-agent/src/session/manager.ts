// WS-C: session registry, tab ownership (I1, I2), transfer, finalize, the
// per-session SystemEvent queue (seq + long-poll) and lease bookkeeping (I4).
// Pure daemon state: talks to the browser only through the injected
// TabCloser so it is unit-testable without Chrome.
import {
  LEASE_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  type KeepStatus,
  type Ownership,
  type SessionCloseResult,
  type SessionId,
  type SessionOpenParams,
  type SessionOpenResult,
  type SystemEvent,
  type TabId,
  type TabInfo,
  type TargetId,
} from "../contract.js";
import { ObuError } from "../errors.js";
import type { LeaseClock } from "../lease/index.js";
import type { SessionRow, SessionTabRow, Store } from "../store/index.js";

export type EventInput = SystemEvent extends infer E ? (E extends SystemEvent ? Omit<E, "seq" | "at" | "sessionId"> : never) : never;

/** Browser side effects the manager needs when sessions end. */
export interface TabCloser {
  /** Close an owned tab. `guard`: leave it open if the user is looking at it; returns false when kept. */
  closeOwned(session: SessionRow, tabId: TabId, opts: { guard: boolean }): Promise<boolean>;
  /** Stop borrowing a user tab (never closes it). */
  releaseBorrowed(session: SessionRow, tabId: TabId): Promise<void>;
  /** Called after a root session is fully closed (extension-level finalize). */
  finalizeRoot?(session: SessionRow, kept: { tabId: TabId; status: KeepStatus }[]): Promise<void>;
  /** Forget per-tab runtime state (CDP sessions, mutex, previous trees). */
  forgetTab?(tabId: TabId): void;
}

interface LiveState {
  events: SystemEvent[];
  seq: number;
  deliveredSeq: number;
  waiters: Set<() => void>;
  /** Previous snapshot tree per tab, for diffs. */
  trees: Map<TabId, string>;
}

const EVENT_RING = 500;
const TAB_LIMIT_WARNING = 5;

export interface SessionManagerOptions {
  store: Store;
  profile: string;
  closer: TabCloser;
  clock?: LeaseClock;
  leaseTtlMs?: number;
}

export class SessionManager {
  readonly store: Store;
  readonly profile: string;
  readonly ttlMs: number;
  readonly clock: LeaseClock;
  #closer: TabCloser;
  #live = new Map<SessionId, LiveState>();
  #closing = new Map<SessionId, Promise<SessionCloseResult>>();

  constructor(options: SessionManagerOptions) {
    this.store = options.store;
    this.profile = options.profile;
    this.#closer = options.closer;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.ttlMs = options.leaseTtlMs ?? LEASE_TTL_MS;
  }

  // -------------------------------------------------------------------------
  // Sessions

  open(params: SessionOpenParams): SessionOpenResult {
    if (!params || typeof params.sessionId !== "string" || !params.sessionId) {
      throw new ObuError("invalid_params", "session.open requires a non-empty sessionId");
    }
    if (params.profile && params.profile !== this.profile) {
      throw new ObuError("profile_mismatch", `this daemon serves Chrome profile "${this.profile}", not "${params.profile}"`);
    }
    const existing = this.store.getSession(params.sessionId);
    const parent = params.parentSessionId ?? null;
    if (existing) {
      if ((existing.parent ?? null) !== parent && params.parentSessionId !== undefined) {
        throw new ObuError("lease_conflict", `session ${params.sessionId} is already open with parent ${existing.parent ?? "(none)"}`);
      }
      this.touch(params.sessionId);
      return this.#openResult(params.sessionId);
    }
    if (parent !== null) {
      if (parent === params.sessionId) throw new ObuError("invalid_params", "a session cannot be its own parent");
      if (!this.store.getSession(parent)) {
        throw new ObuError("unknown_session", `parent session ${parent} is not open; open it first`);
      }
    }
    const now = this.clock.now();
    this.store.upsertSession({
      id: params.sessionId,
      parent,
      label: params.label ?? null,
      profile: this.profile,
      heartbeatAt: now,
      expiresAt: now + this.ttlMs,
    });
    this.#ensureLive(params.sessionId);
    return this.#openResult(params.sessionId);
  }

  #openResult(sessionId: SessionId): SessionOpenResult {
    return {
      sessionId,
      leaseTtlMs: this.ttlMs,
      heartbeatIntervalMs: Math.min(HEARTBEAT_INTERVAL_MS, Math.floor(this.ttlMs / 4)),
      profile: this.profile,
      tabs: this.tabInfos(sessionId),
    };
  }

  /** Validate + renew. Every call on a session renews its lease. */
  require(sessionId: unknown): SessionRow {
    if (typeof sessionId !== "string" || !sessionId) throw new ObuError("invalid_params", "sessionId is required");
    const row = this.store.getSession(sessionId);
    if (!row || this.#closing.has(sessionId)) {
      throw new ObuError("unknown_session", `session ${sessionId} is not open (closed or lease expired); call session.open first`);
    }
    return this.touch(sessionId)!;
  }

  touch(sessionId: SessionId): SessionRow | undefined {
    const row = this.store.getSession(sessionId);
    if (!row) return undefined;
    const now = this.clock.now();
    row.heartbeatAt = now;
    row.expiresAt = now + this.ttlMs;
    this.store.upsertSession(row);
    return row;
  }

  get(sessionId: SessionId): SessionRow | undefined {
    return this.store.getSession(sessionId);
  }

  list(): SessionRow[] {
    return this.store.listSessions();
  }

  children(sessionId: SessionId): SessionRow[] {
    return this.store.listSessions().filter((row) => row.parent === sessionId);
  }

  root(sessionId: SessionId): SessionRow {
    let row = this.store.getSession(sessionId);
    if (!row) throw new ObuError("unknown_session", `session ${sessionId} is not open`);
    const seen = new Set<SessionId>();
    while (row.parent && !seen.has(row.id)) {
      seen.add(row.id);
      const parent = this.store.getSession(row.parent);
      if (!parent) break;
      row = parent;
    }
    return row;
  }

  /** Sessions whose lease has expired at `now`. */
  expired(now: number = this.clock.now()): SessionRow[] {
    return this.store.listSessions().filter((row) => row.expiresAt <= now && !this.#closing.has(row.id));
  }

  /**
   * session.close: close owned tabs not kept, release borrowed ones, cascade to
   * children first. Idempotent while in flight.
   */
  close(
    sessionId: SessionId,
    keep: { tabId: TabId; status: KeepStatus }[] = [],
    reason: "agent" | "lease_expired" | "reconcile" = "agent",
  ): Promise<SessionCloseResult> {
    const inFlight = this.#closing.get(sessionId);
    if (inFlight) return inFlight;
    const row = this.store.getSession(sessionId);
    if (!row) return Promise.reject(new ObuError("unknown_session", `session ${sessionId} is not open`));
    const owned = new Set(this.store.tabsOf(sessionId).map((tab) => tab.tabId));
    for (const entry of keep ?? []) {
      if (!owned.has(entry.tabId)) {
        return Promise.reject(new ObuError("tab_not_owned", `cannot keep tab ${entry.tabId}: it is not owned by session ${sessionId}`, { tabId: entry.tabId }));
      }
    }
    const promise = this.#doClose(row, keep, reason).finally(() => this.#closing.delete(sessionId));
    this.#closing.set(sessionId, promise);
    return promise;
  }

  async #doClose(row: SessionRow, keep: { tabId: TabId; status: KeepStatus }[], reason: "agent" | "lease_expired" | "reconcile"): Promise<SessionCloseResult> {
    const closedTabIds: TabId[] = [];
    const keptTabIds: TabId[] = [];
    // Children first: their tabs never outlive the parent.
    for (const child of this.children(row.id)) {
      const result = await this.close(child.id, [], reason === "agent" ? "agent" : reason).catch(() => undefined);
      if (result) closedTabIds.push(...result.closedTabIds);
    }
    const keepMap = new Map(keep.map((entry) => [entry.tabId, entry.status]));
    for (const tab of this.store.tabsOf(row.id)) {
      if (keepMap.has(tab.tabId)) {
        keptTabIds.push(tab.tabId);
        continue;
      }
      if (tab.ownership === "borrowed") {
        await this.#closer.releaseBorrowed(row, tab.tabId).catch(() => undefined);
        continue;
      }
      const closed = await this.#closer.closeOwned(row, tab.tabId, { guard: reason !== "agent" }).catch(() => true);
      if (closed) closedTabIds.push(tab.tabId);
      else keptTabIds.push(tab.tabId);
    }
    if (!row.parent && this.#closer.finalizeRoot) {
      const kept = keptTabIds.map((tabId) => ({ tabId, status: keepMap.get(tabId) ?? ("handoff" as KeepStatus) }));
      await this.#closer.finalizeRoot(row, kept).catch(() => undefined);
    }
    for (const tab of this.store.tabsOf(row.id)) this.#closer.forgetTab?.(tab.tabId);
    this.store.deleteSession(row.id);
    const live = this.#live.get(row.id);
    this.#live.delete(row.id);
    if (live) for (const wake of live.waiters) wake();
    if (reason !== "agent" && row.parent && this.store.getSession(row.parent) && closedTabIds.length) {
      this.emit(row.parent, { type: "orphans_closed", tabIds: closedTabIds });
    }
    return { closedTabIds, keptTabIds };
  }

  // -------------------------------------------------------------------------
  // Tabs

  addTab(sessionId: SessionId, tab: { tabId: TabId; targetId?: TargetId | null; ownership: Ownership }, makeActive: boolean): void {
    const owner = this.store.ownerOf(tab.tabId);
    if (owner && owner.sessionId !== sessionId) {
      throw new ObuError("tab_not_owned", `tab ${tab.tabId} is already used by session ${owner.sessionId}`, { tabId: tab.tabId });
    }
    const hadActive = this.store.tabsOf(sessionId).some((row) => row.active);
    this.store.putTab({ sessionId, tabId: tab.tabId, targetId: tab.targetId ?? null, ownership: tab.ownership, active: false });
    if (makeActive || !hadActive) this.store.setActive(sessionId, tab.tabId);
    const open = this.#rootTabCount(sessionId);
    if (open >= TAB_LIMIT_WARNING) this.emit(sessionId, { type: "tab_limit_warning", openTabs: open });
  }

  #rootTabCount(sessionId: SessionId): number {
    const root = this.root(sessionId);
    const ids = this.#descendants(root.id);
    return ids.reduce((sum, id) => sum + this.store.tabsOf(id).filter((tab) => tab.ownership === "owned").length, 0);
  }

  #descendants(sessionId: SessionId): SessionId[] {
    const out = [sessionId];
    for (const child of this.children(sessionId)) out.push(...this.#descendants(child.id));
    return out;
  }

  /** Resolve a page call's tab: explicit tabId must be this session's (I2); omitted = active (I1). */
  resolveTab(sessionId: SessionId, tabId?: TabId): SessionTabRow {
    if (tabId === undefined || tabId === null) {
      const active = this.store.tabsOf(sessionId).find((tab) => tab.active);
      if (!active) throw new ObuError("no_active_tab", "this session has no active tab: open one with tabs.open (or tabs.attach a user tab) first");
      return active;
    }
    if (typeof tabId !== "number") throw new ObuError("invalid_params", "tabId must be a number");
    const owner = this.store.ownerOf(tabId);
    if (!owner || owner.sessionId !== sessionId) {
      const by = owner ? ` (owned by session ${owner.sessionId}${this.#isRelated(sessionId, owner.sessionId) ? "; use tabs.transfer to hand it over" : ""})` : "";
      throw new ObuError("tab_not_owned", `tab ${tabId} is not owned by this session${by}`, { tabId });
    }
    return owner;
  }

  #isRelated(a: SessionId, b: SessionId): boolean {
    return this.store.getSession(a)?.parent === b || this.store.getSession(b)?.parent === a;
  }

  select(sessionId: SessionId, tabId: TabId): TabId {
    this.resolveTab(sessionId, tabId);
    this.store.setActive(sessionId, tabId);
    return tabId;
  }

  /** Forget a tab (closed/released/revoked). Returns the session's new active tab. */
  dropTab(tabId: TabId): { sessionId: SessionId; activeTabId?: TabId } | undefined {
    const owner = this.store.ownerOf(tabId);
    if (!owner) return undefined;
    this.store.removeTab(tabId);
    this.#live.get(owner.sessionId)?.trees.delete(tabId);
    let activeTabId = this.store.tabsOf(owner.sessionId).find((tab) => tab.active)?.tabId;
    if (owner.active || activeTabId === undefined) {
      const remaining = this.store.tabsOf(owner.sessionId);
      activeTabId = remaining.length ? remaining[remaining.length - 1].tabId : undefined;
      this.store.setActive(owner.sessionId, activeTabId ?? null);
    }
    return { sessionId: owner.sessionId, activeTabId };
  }

  transfer(sessionId: SessionId, tabId: TabId, toSessionId: SessionId): TabId | undefined {
    const tab = this.resolveTab(sessionId, tabId);
    const target = this.store.getSession(toSessionId);
    if (!target) throw new ObuError("unknown_session", `session ${toSessionId} is not open`);
    if (!this.#isRelated(sessionId, toSessionId)) {
      throw new ObuError("invalid_params", `tabs.transfer only hands tabs between a parent and its direct child (${sessionId} -> ${toSessionId})`);
    }
    this.store.removeTab(tabId);
    this.#live.get(sessionId)?.trees.delete(tabId);
    const targetHasActive = this.store.tabsOf(toSessionId).some((row) => row.active);
    this.store.putTab({ ...tab, sessionId: toSessionId, active: false });
    if (!targetHasActive) this.store.setActive(toSessionId, tabId);
    if (tab.active) {
      const remaining = this.store.tabsOf(sessionId);
      this.store.setActive(sessionId, remaining.length ? remaining[remaining.length - 1].tabId : null);
    }
    return this.store.tabsOf(sessionId).find((row) => row.active)?.tabId;
  }

  activeTabId(sessionId: SessionId): TabId | undefined {
    return this.store.tabsOf(sessionId).find((tab) => tab.active)?.tabId;
  }

  tabInfos(sessionId: SessionId, details?: Map<TabId, { url: string; title: string }>): TabInfo[] {
    return this.store.tabsOf(sessionId).map((tab) => ({
      tabId: tab.tabId,
      ...(tab.targetId ? { targetId: tab.targetId } : {}),
      url: details?.get(tab.tabId)?.url ?? "",
      title: details?.get(tab.tabId)?.title ?? "",
      ownership: tab.ownership,
      active: tab.active,
      sessionId,
    }));
  }

  descendantsOf(sessionId: SessionId): SessionId[] {
    return this.#descendants(sessionId);
  }

  // -------------------------------------------------------------------------
  // Previous snapshot trees (for diffs)

  previousTree(sessionId: SessionId, tabId: TabId): string | undefined {
    return this.#live.get(sessionId)?.trees.get(tabId);
  }

  setPreviousTree(sessionId: SessionId, tabId: TabId, tree: string): void {
    this.#ensureLive(sessionId).trees.set(tabId, tree);
  }

  // -------------------------------------------------------------------------
  // Events

  emit(sessionId: SessionId, event: EventInput): SystemEvent | undefined {
    if (!this.store.getSession(sessionId)) return undefined;
    const live = this.#ensureLive(sessionId);
    const full = { ...event, seq: ++live.seq, at: this.clock.now(), sessionId } as SystemEvent;
    live.events.push(full);
    if (live.events.length > EVENT_RING) live.events.splice(0, live.events.length - EVENT_RING);
    for (const wake of live.waiters) wake();
    return full;
  }

  /** Undelivered events, marked delivered (appended to the next result). */
  drain(sessionId: SessionId): SystemEvent[] {
    const live = this.#live.get(sessionId);
    if (!live) return [];
    const events = live.events.filter((event) => event.seq > live.deliveredSeq);
    live.deliveredSeq = live.seq;
    return events;
  }

  /** session.events: events after `afterSeq`; long-polls up to `waitMs` (≤ 30 s) when none. */
  async events(sessionId: SessionId, afterSeq = 0, waitMs = 0): Promise<{ events: SystemEvent[]; lastSeq: number }> {
    const live = this.#ensureLive(sessionId);
    const pick = () => live.events.filter((event) => event.seq > afterSeq);
    let events = pick();
    if (!events.length && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(waitMs, 30_000));
        function done() {
          clearTimeout(timer);
          live.waiters.delete(done);
          resolve();
        }
        live.waiters.add(done);
      });
      this.touch(sessionId);
      events = pick();
    }
    live.deliveredSeq = Math.max(live.deliveredSeq, live.seq);
    return { events, lastSeq: live.seq };
  }

  /** Resolve when an event matching `predicate` arrives after `afterSeq`. */
  waitForEvent(sessionId: SessionId, predicate: (event: SystemEvent) => boolean, timeoutMs: number, afterSeq?: number): Promise<SystemEvent | undefined> {
    const live = this.#ensureLive(sessionId);
    const from = afterSeq ?? live.seq;
    const find = () => live.events.find((event) => event.seq > from && predicate(event));
    const found = find();
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const check = () => {
        if (!this.#live.has(sessionId)) return finish(undefined);
        const event = find();
        if (event) finish(event);
      };
      function finish(event: SystemEvent | undefined) {
        clearTimeout(timer);
        live.waiters.delete(check);
        resolve(event);
      }
      live.waiters.add(check);
    });
  }

  lastSeq(sessionId: SessionId): number {
    return this.#live.get(sessionId)?.seq ?? 0;
  }

  #ensureLive(sessionId: SessionId): LiveState {
    let live = this.#live.get(sessionId);
    if (!live) {
      live = { events: [], seq: 0, deliveredSeq: 0, waiters: new Set(), trees: new Map() };
      this.#live.set(sessionId, live);
    }
    return live;
  }
}
