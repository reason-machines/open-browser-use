/**
 * obu-agent daemon contract (v1).
 *
 * Single source of truth for the JSON-RPC surface every stream codes against:
 * WS-C (daemon core) implements it, WS-D/WS-E plug into it, WS-F (our product)
 * generates its mock daemon and tool schemas from it. Human-readable mirror:
 * docs/agent/contract.md — change both in the same commit.
 *
 * Transport: JSON-RPC 2.0, newline-delimited JSON, over a unix socket at
 *   ~/Library/Application Support/Reason/browser/<profile>/agent.sock (0600)
 * plus MCP stdio via `obu-agent mcp --attach` (thin proxy onto the socket).
 */

export const CONTRACT_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Chrome tab id (chrome.tabs). Stable for the tab's lifetime. */
export type TabId = number;
/** CDP target id of a tab's main frame. */
export type TargetId = string;
/** Agent session id. Caller-chosen, unique per agent (subagents get their own). */
export type SessionId = string;
/**
 * Snapshot ref. `eN` in the main frame, `fKeN` inside the K-th iframe
 * (frame ordinal assigned by the daemon at stitch time). Refs are virtual
 * locators: never mix them into CSS selectors.
 */
export type Ref = string;

export type Ownership = "owned" | "borrowed";
export type KeepStatus = "handoff" | "deliverable";

/** Every page-level request may name a tab; omitted = the session's active tab. */
export interface TabTarget {
  sessionId: SessionId;
  tabId?: TabId;
}

export interface TabInfo {
  tabId: TabId;
  targetId?: TargetId;
  url: string;
  title: string;
  ownership?: Ownership;
  /** True for the session's single active tab. */
  active?: boolean;
  /** Session that owns the tab (present for scope 'mine+children'). */
  sessionId?: SessionId;
  /** Present for scope 'browser' (the user's tab strip, read-only). */
  groupTitle?: string;
  lastAccessed?: number;
}

// ---------------------------------------------------------------------------
// Sessions & leases
// ---------------------------------------------------------------------------

export const LEASE_TTL_MS = 60_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SessionOpenParams {
  sessionId: SessionId;
  /** Set for subagents: the child gets its own tabs and may not act on the parent's. */
  parentSessionId?: SessionId;
  /** Human label; used for the tab-group title "<label> · Reason". */
  label?: string;
  /** Chrome profile directory ("Default", "Profile 1"). Rejected with profile_mismatch if not this daemon's. */
  profile?: string;
}
export interface SessionOpenResult {
  sessionId: SessionId;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  profile: string;
  /** Tabs already owned (re-open of a live session is idempotent). */
  tabs: TabInfo[];
}

export interface SessionHeartbeatParams {
  sessionId: SessionId;
}
export interface SessionHeartbeatResult {
  expiresAt: number;
}

export interface SessionCloseParams {
  sessionId: SessionId;
  /** Owned tabs to leave open for the user; every other owned tab is closed. Borrowed tabs are always left alone. */
  keep?: { tabId: TabId; status: KeepStatus }[];
}
export interface SessionCloseResult {
  closedTabIds: TabId[];
  keptTabIds: TabId[];
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type TabsListScope = "mine" | "mine+children" | "browser";
export interface TabsListParams {
  sessionId: SessionId;
  scope?: TabsListScope; // default 'mine'
}
export interface TabsListResult {
  tabs: TabInfo[];
  activeTabId?: TabId;
}

export interface TabsOpenParams {
  sessionId: SessionId;
  url: string;
  /** Make it the session's active tab (default true). Never focuses the window or steals the user's active tab. */
  makeActive?: boolean;
  /** Return a snapshot of the loaded page in the same round trip. */
  snapshot?: SnapshotMode;
}
export interface TabsOpenResult extends ActionResultBase {
  tabId: TabId;
  targetId: TargetId;
  url: string;
  title: string;
}

export interface TabsAttachParams {
  sessionId: SessionId;
  tabId: TabId;
}
export interface TabsAttachResult {
  tab: TabInfo; // ownership 'borrowed'
}

export interface TabsSelectParams {
  sessionId: SessionId;
  tabId: TabId;
}
export interface TabsCloseParams {
  sessionId: SessionId;
  tabId: TabId;
}
export interface TabsTransferParams {
  sessionId: SessionId; // current owner
  tabId: TabId;
  toSessionId: SessionId; // parent or child
}
export interface TabsMutationResult {
  activeTabId?: TabId;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const DEFAULT_SNAPSHOT_MAX_CHARS = 40_000;

export interface SnapshotParams extends TabTarget {
  /** Only interactive nodes + landmarks + headings (cheap first read). */
  interactive?: boolean;
  /** Scope to a subtree by ref. */
  ref?: Ref;
  /** Scope to a subtree by CSS selector (main frame). */
  selector?: string;
  /** Include hidden subtrees. */
  showHidden?: boolean;
  /** Exceeding this returns snapshot_too_large with advice — never a truncated tree. */
  maxChars?: number;
}
export interface SnapshotResult {
  /** Playwright-style aria YAML, header `- title: "…" [url=…]`. */
  tree: string;
  /** Unified diff vs the previous snapshot of this (session, tab); '' on first snapshot. */
  diff: string;
  url: string;
  title: string;
  tabId: TabId;
  refCount: number;
  warnings: string[];
  events: SystemEvent[];
}

/** What a mutating call returns about the page afterwards. */
export type SnapshotMode = "diff" | "tree" | "none";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionKind =
  | "click"
  | "dblclick"
  | "hover"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "check"
  | "uncheck"
  | "drag"
  | "upload"
  | "scroll";

export interface Coords {
  x: number;
  y: number;
}

export interface ActParams extends TabTarget {
  action: ActionKind;
  /** Exactly one of ref | selector | coords for element actions. `press` may omit (focused element). */
  ref?: Ref;
  selector?: string;
  coords?: Coords;
  /** fill/type text; select value or label; scroll direction 'up'|'down'|'left'|'right'. */
  value?: string | string[];
  /** press: Playwright key syntax, e.g. "Enter", "ControlOrMeta+A", "Shift+Tab". */
  keys?: string;
  /** upload: absolute local paths. */
  files?: string[];
  /** drag: drop target. */
  to?: { ref?: Ref; selector?: string; coords?: Coords };
  /** Modifiers for click. */
  modifiers?: ("Alt" | "Control" | "Meta" | "Shift" | "ControlOrMeta")[];
  button?: "left" | "right" | "middle";
  /** Actionability timeout (default 5000). */
  timeoutMs?: number;
  /** Default 'diff'. */
  snapshot?: SnapshotMode;
}

export type SettleKind = "nav" | "spa" | "dom" | "none";
export interface Settled {
  kind: SettleKind;
  ms: number;
  /** Set when the 8 s cap hit: a warning, not an error. */
  warning?: string;
}

export interface ActionResultBase {
  ok: true;
  settled: Settled;
  snapshot?: { tree?: string; diff?: string; url: string; title: string };
  events: SystemEvent[];
  /** Human-readable notes, e.g. "fell back to DOM click (obscured)". */
  warnings?: string[];
}
export type ActResult = ActionResultBase & {
  /** upload/download artefacts etc. */
  details?: Record<string, unknown>;
};

export interface NavigateParams extends TabTarget {
  url?: string;
  /** History/reload instead of url. */
  op?: "back" | "forward" | "reload";
  waitUntil?: "settled" | "domcontentloaded" | "load" | "none"; // default 'settled'
  snapshot?: SnapshotMode;
}
export type NavigateResult = ActionResultBase;

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export interface ScreenshotParams extends TabTarget {
  ref?: Ref;
  fullPage?: boolean;
  /** Draw numbered ref boxes (set-of-marks) for the capture. */
  annotate?: boolean;
  format?: "jpeg" | "webp" | "png"; // default 'jpeg'
  quality?: number; // default 70
  maxWidth?: number; // default 1280
}
export interface ScreenshotResult {
  /** Absolute file path. Images never travel as base64 in tool results. */
  path: string;
  mime: string;
  width: number;
  height: number;
  /** 'capture' | 'screencast' (fallback when capture hangs > 2 s on a hidden tab). */
  via: "capture" | "screencast";
}

// ---------------------------------------------------------------------------
// Escape hatches & waits
// ---------------------------------------------------------------------------

export interface EvaluateParams extends TabTarget {
  expression: string;
  /** Default 'isolated'. 'page' must be explicit. Never triggers Runtime.enable. */
  world?: "isolated" | "page";
  awaitPromise?: boolean;
}
export interface EvaluateResult {
  value: unknown;
  events: SystemEvent[];
}

/** Methods with these prefixes are refused by `cdp`. */
export const CDP_DENYLIST_PREFIXES = ["Target.", "Browser.", "Runtime.enable", "Debugger.enable"] as const;
export interface CdpParams extends TabTarget {
  method: string;
  params?: Record<string, unknown>;
  /** Route to an OOPIF child session by frame ref prefix ('f2'). */
  frameRef?: string;
  timeoutMs?: number;
}
export interface CdpResult {
  result: unknown;
}

export type WaitFor = "download" | "popup" | "dialog" | "selector" | "text" | "url" | "settled";
export interface WaitParams extends TabTarget {
  for: WaitFor;
  selector?: string;
  text?: string;
  /** Glob or substring for 'url'. */
  url?: string;
  /** dialog: how to answer the next dialog. */
  dialogAction?: { accept: boolean; promptText?: string };
  timeoutMs?: number; // default 30000
}
export interface WaitResult {
  ok: boolean;
  event?: SystemEvent;
  download?: DownloadInfo;
  tab?: TabInfo;
  warnings?: string[];
}

export interface DownloadInfo {
  downloadId: number;
  url: string;
  path: string;
  mime?: string;
  bytes?: number;
  state: "in_progress" | "complete" | "interrupted";
  tabId?: TabId;
}

// Round 2 (declared now so tool schemas are stable).
export interface NetworkCaptureParams extends TabTarget {
  op: "start" | "stop";
  filter?: { urlIncludes?: string; resourceTypes?: string[] };
}
export interface CapturedRequest {
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  /** Header values redacted for cookie/authorization/token-like names. */
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  bodyPath?: string;
}
export interface NetworkCaptureResult {
  requests: CapturedRequest[];
}
export interface FetchInPageParams extends TabTarget {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
  /** Default false: same-origin only. */
  allowCrossOrigin?: boolean;
}
export interface FetchInPageResult {
  status: number;
  headers: Record<string, string>;
  bodyPath: string;
  bytes: number;
}

// Code mode (r2-repl): a persistent per-session JS sandbox with a
// Playwright-compatible `page`/`context` bound to the same action layer.
export interface ReplRunParams {
  sessionId: SessionId;
  /** JavaScript; top-level await allowed; bindings persist across calls. Print with console.log. */
  code: string;
  /** Default 30000, max 300000. */
  timeoutMs?: number;
}
export interface ReplRunResult {
  /** false when the cell threw; output printed before the throw is kept. */
  ok: boolean;
  /** console output, newline-joined. */
  output: string;
  /** Inspected value of the cell's last expression, if any. */
  value?: string;
  error?: { name: string; message: string; code?: string; stack?: string };
  /** Images passed to display() / annotatedScreenshot(), for the model to see. */
  images: { path: string; mime: string }[];
  warnings?: string[];
  /** The REPL's ./artifacts directory (absolute). */
  artifactsDir: string;
  ms: number;
  events: SystemEvent[];
}
export interface ReplResetParams {
  sessionId: SessionId;
}
export interface ReplResetResult {
  ok: true;
}

export interface SessionEventsParams {
  sessionId: SessionId;
  afterSeq?: number;
  /** Long-poll up to this long for new events. */
  waitMs?: number;
}
export interface SessionEventsResult {
  events: SystemEvent[];
  lastSeq: number;
}

export interface DaemonInfoResult {
  contractVersion: string;
  daemonVersion: string;
  profile: string;
  pid: number;
  startedAt: number;
  extension: { connected: boolean; version?: string };
  sessions: number;
}

// ---------------------------------------------------------------------------
// System events (steering) — appended to every result and streamed with seq.
// Rendered to agents as `[system] …` lines (see renderSystemEvent).
// ---------------------------------------------------------------------------

interface EventBase {
  seq: number;
  at: number;
  sessionId: SessionId;
  tabId?: TabId;
}
export type SystemEvent =
  | (EventBase & { type: "popup_opened"; tab: TabInfo; openerTabId: TabId })
  | (EventBase & { type: "tab_closed"; reason: "user" | "agent" | "crash" | "lease_expired"; activeTabId?: TabId })
  | (EventBase & { type: "download_started"; download: DownloadInfo })
  | (EventBase & { type: "download_finished"; download: DownloadInfo })
  | (EventBase & {
      type: "dialog";
      dialogType: "alert" | "confirm" | "prompt" | "beforeunload";
      message: string;
      action: "accepted" | "dismissed";
    })
  | (EventBase & { type: "navigation"; url: string; kind: "nav" | "spa" })
  | (EventBase & { type: "lease_revoked"; reason: "dragged_out_of_group" | "user_closed" | "user_took_over" })
  | (EventBase & { type: "orphans_closed"; tabIds: TabId[] })
  | (EventBase & { type: "tab_limit_warning"; openTabs: number });

export type SystemEventType = SystemEvent["type"];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const ERROR_CODES = {
  stale_ref: -32010,
  not_actionable: -32011,
  obscured: -32012,
  lease_conflict: -32013,
  tab_not_owned: -32014,
  profile_mismatch: -32015,
  snapshot_too_large: -32016,
  timeout: -32017,
  no_active_tab: -32018,
  unknown_session: -32019,
  cdp_denied: -32020,
  extension_disconnected: -32021,
  invalid_params: -32602,
  method_not_found: -32601,
  not_implemented: -32050,
  internal: -32603,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

/** `error.data` of a JSON-RPC error. `message` always reaches the agent verbatim. */
export interface ObuErrorData {
  code: ErrorCode;
  /** not_actionable: 'detached'|'hidden'|'disabled'|'unstable'|'not_editable' */
  reason?: string;
  /** obscured: role+name of the element on top. */
  by?: string;
  /** snapshot_too_large: what to do instead. */
  advice?: string;
  /** timeout: which stage timed out. */
  stage?: string;
  ref?: Ref;
  tabId?: TabId;
}

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: P;
}
export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result: R;
}
export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: ObuErrorData };
}
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

// ---------------------------------------------------------------------------
// Method table
// ---------------------------------------------------------------------------

export interface MethodMap {
  "daemon.info": { params: Record<string, never>; result: DaemonInfoResult };
  "session.open": { params: SessionOpenParams; result: SessionOpenResult };
  "session.heartbeat": { params: SessionHeartbeatParams; result: SessionHeartbeatResult };
  "session.close": { params: SessionCloseParams; result: SessionCloseResult };
  "session.events": { params: SessionEventsParams; result: SessionEventsResult };
  "tabs.list": { params: TabsListParams; result: TabsListResult };
  "tabs.open": { params: TabsOpenParams; result: TabsOpenResult };
  "tabs.attach": { params: TabsAttachParams; result: TabsAttachResult };
  "tabs.select": { params: TabsSelectParams; result: TabsMutationResult };
  "tabs.close": { params: TabsCloseParams; result: TabsMutationResult };
  "tabs.transfer": { params: TabsTransferParams; result: TabsMutationResult };
  snapshot: { params: SnapshotParams; result: SnapshotResult };
  act: { params: ActParams; result: ActResult };
  navigate: { params: NavigateParams; result: NavigateResult };
  screenshot: { params: ScreenshotParams; result: ScreenshotResult };
  evaluate: { params: EvaluateParams; result: EvaluateResult };
  cdp: { params: CdpParams; result: CdpResult };
  wait: { params: WaitParams; result: WaitResult };
  "network.capture": { params: NetworkCaptureParams; result: NetworkCaptureResult };
  fetchInPage: { params: FetchInPageParams; result: FetchInPageResult };
  "repl.run": { params: ReplRunParams; result: ReplRunResult };
  "repl.reset": { params: ReplResetParams; result: ReplResetResult };
}
export type MethodName = keyof MethodMap;
export type ParamsOf<M extends MethodName> = MethodMap[M]["params"];
export type ResultOf<M extends MethodName> = MethodMap[M]["result"];

export const METHODS: readonly MethodName[] = [
  "daemon.info",
  "session.open",
  "session.heartbeat",
  "session.close",
  "session.events",
  "tabs.list",
  "tabs.open",
  "tabs.attach",
  "tabs.select",
  "tabs.close",
  "tabs.transfer",
  "snapshot",
  "act",
  "navigate",
  "screenshot",
  "evaluate",
  "cdp",
  "wait",
  "network.capture",
  "fetchInPage",
  "repl.run",
  "repl.reset",
] as const;

/** Methods that only read state; safe to run in parallel across sessions (WS-F executionMode). */
export const READ_ONLY_METHODS: ReadonlySet<MethodName> = new Set<MethodName>([
  "daemon.info",
  "session.heartbeat",
  "session.events",
  "tabs.list",
  "snapshot",
  "screenshot",
]);

// ---------------------------------------------------------------------------
// Invariants (enforced by WS-C; tested in test/invariants.*)
// ---------------------------------------------------------------------------
// I1 A session has at most one active tab; page calls without tabId use it.
// I2 A tab is owned by at most one session. Children cannot act on parent tabs
//    (and vice versa) without tabs.transfer.  -> tab_not_owned
// I3 Per-tab async mutex serialises page calls; different tabs run in parallel.
// I4 Lease expiry (no call/heartbeat for LEASE_TTL_MS) == session.close with no keep.
// I5 Daemon start reconciles: tabs in agent groups with no live lease are closed
//    (unless the user is looking at it); orphans_closed is emitted to the parent.
// I6 Owned tabs: 1440x900 metrics override, lifecycle 'active', auto-attach OOPIFs.
//    Borrowed tabs: no metrics override.
// I7 Focus emulation is enabled only for the duration of act/navigate/snapshot.
// I8 Never send Runtime.enable / Debugger.enable to agent pages.

export const AGENT_VIEWPORT = { width: 1440, height: 900 } as const;
export const MIN_STABLE_VIEWPORT = { width: 960, height: 540 } as const;
export const UTILITY_WORLD_NAME = "__obu_utility";
