# obu-agent contract v1.0.0

Exact types: `packages/obu-agent/src/contract.ts` (methods, params, results,
events, errors), `src/seams.ts` (internal seams), `src/injected/api.ts`
(injected-world API). This document is their human-readable mirror plus the
behaviour spec. Change both in the same commit.

## Transport

- One `obu-agent` per Chrome profile, spawned on demand by the native host
  (or `obu-agent --profile "Profile 1"`).
- Socket: `~/Library/Application Support/Reason/browser/<profile>/agent.sock`,
  mode 0600. Auth: `getpeereid` same uid **and** first line
  `{"auth":"<token>"}` from `agent.token` (0600). (Token check: WS-C.)
- JSON-RPC 2.0, newline-delimited JSON. MCP stdio: `obu-agent mcp --attach`
  proxies onto the socket with static tool schemas.
- Daemon ⇄ extension (through the native host): **extension wire v2**, spec in
  `apps/chrome-extension/WIRE.md` — implicit attach, `target.sessionId` child
  sessions, `subscribe`, chunked host→extension frames, `route{profileId}`,
  notifications `debuggerAttached/Detached`, `leaseRevoked`, `popupOpened`,
  `tabClosed`, `sessionExpired`, correlated `onDownloadChange`. On
  `debuggerAttached` the daemon re-runs its attach sequence (the extension
  idle-detaches after 30 s to clear Chrome's debugging infobar).

## Methods

All page methods take `{sessionId, tabId?}`; `tabId` omitted = the session's
active tab (I1). Every page result carries `events: SystemEvent[]`.

| Method | Params | Result |
|---|---|---|
| `daemon.info` | — | `{contractVersion, daemonVersion, profile, pid, startedAt, extension{connected,version}, sessions}` |
| `session.open` | `{sessionId, parentSessionId?, label?, profile?}` | `{sessionId, leaseTtlMs:60000, heartbeatIntervalMs:15000, profile, tabs[]}` (idempotent) |
| `session.heartbeat` | `{sessionId}` | `{expiresAt}` — any call also renews |
| `session.close` | `{sessionId, keep?:[{tabId, status:'handoff'\|'deliverable'}]}` | `{closedTabIds, keptTabIds}` — closes owned tabs not kept; borrowed untouched |
| `session.events` | `{sessionId, afterSeq?, waitMs?}` | `{events, lastSeq}` (long-poll) |
| `tabs.list` | `{sessionId, scope?:'mine'\|'mine+children'\|'browser'}` | `{tabs: TabInfo[], activeTabId?}` — `browser` = user's strip, read-only, no attach |
| `tabs.open` | `{sessionId, url, makeActive?=true, snapshot?}` | `{tabId, targetId, url, title, ok, settled, snapshot?, events}` — background, grouped, never focused |
| `tabs.attach` | `{sessionId, tabId}` | `{tab}` — explicit claim of a user tab as **borrowed** |
| `tabs.select` | `{sessionId, tabId}` | `{activeTabId}` — session-local; never activates the Chrome tab |
| `tabs.close` | `{sessionId, tabId}` | `{activeTabId?}` — owned only; close guard applies |
| `tabs.transfer` | `{sessionId, tabId, toSessionId}` | `{activeTabId?}` — parent↔child handover |
| `snapshot` | `{interactive?, ref?, selector?, showHidden?, maxChars?=40000}` | `{tree, diff, url, title, tabId, refCount, warnings, events}` |
| `act` | `{action, ref\|selector\|coords, value?, keys?, files?, to?, modifiers?, button?, timeoutMs?=5000, snapshot?='diff'}` | `{ok, settled{kind,ms,warning?}, snapshot?, events, warnings?, details?}` |
| `navigate` | `{url? \| op?:'back'\|'forward'\|'reload', waitUntil?='settled', snapshot?}` | same shape as `act` |
| `screenshot` | `{ref?, fullPage?, annotate?, format?='jpeg', quality?=70, maxWidth?=1280}` | `{path, mime, width, height, via:'capture'\|'screencast'}` |
| `evaluate` | `{expression, world?='isolated', awaitPromise?}` | `{value, events}` — page world must be explicit |
| `cdp` | `{method, params?, frameRef?, timeoutMs?}` | `{result}` — denies `Target.*`, `Browser.*`, `Runtime.enable`, `Debugger.enable` |
| `wait` | `{for:'download'\|'popup'\|'dialog'\|'selector'\|'text'\|'url'\|'settled', selector?, text?, url?, dialogAction?, timeoutMs?=30000}` | `{ok, event?, download?, tab?, warnings?}` |
| `network.capture` (r2) | `{op:'start'\|'stop', filter?}` | `{requests[]}` — auth/cookie headers redacted, bodies to files |
| `fetchInPage` (r2) | `{url, init?, allowCrossOrigin?=false}` | `{status, headers, bodyPath, bytes}` |

`act` actions: `click dblclick hover fill type press select check uncheck drag upload scroll`.
`press` keys use Playwright syntax (`Enter`, `ControlOrMeta+A`, `Shift+Tab`).

Read-only methods (safe to parallelise across sessions): `daemon.info,
session.heartbeat, session.events, tabs.list, snapshot, screenshot`.

MCP tool names: `browser_tabs_list/open/attach/select/close, browser_snapshot,
browser_act, browser_navigate, browser_screenshot, browser_wait,
browser_evaluate, browser_cdp, browser_finish (= session.close)`.

## System events

Appended to every result and streamed via `session.events` with per-session
`seq`. Rendered to agents as `[system] …` (`src/events.ts`).

`popup_opened{tab, openerTabId}` · `tab_closed{reason, activeTabId?}` ·
`download_started{download}` · `download_finished{download}` ·
`dialog{dialogType, message, action}` · `navigation{url, kind}` ·
`lease_revoked{reason}` · `orphans_closed{tabIds}` · `tab_limit_warning{openTabs}` (≥5).

## Errors

JSON-RPC `error.code` from `ERROR_CODES`; `error.data = {code, reason?, by?, advice?, stage?, ref?, tabId?}`.
The message reaches the agent verbatim and says what to do next.

| code | when |
|---|---|
| `stale_ref` | ref no longer resolves (even via role+name+nth fallback) → re-snapshot |
| `not_actionable{reason}` | detached / hidden / disabled / unstable / not_editable after timeout |
| `obscured{by}` | hit test lands on another element and the DOM-click fallback was not applicable |
| `lease_conflict` | session expired/closed or opened twice with a different parent |
| `tab_not_owned` | tab belongs to another session (I2) |
| `profile_mismatch` | request profile ≠ daemon profile |
| `snapshot_too_large{advice}` | over `maxChars`: advice = use `interactive`, `ref`, or `selector` |
| `timeout{stage}` | actionability / CDP / wait timeout (settle timeouts are warnings) |
| `no_active_tab` | page call without tabId and the session has none |
| `unknown_session` | call before `session.open` (or after close) |
| `cdp_denied` | `cdp` method on the deny list |
| `extension_disconnected` | native host / extension not reachable |
| `not_implemented`, `method_not_found`, `invalid_params`, `internal` | — |

## Invariants (WS-C enforces, tests prove)

1. A session has at most one active tab; page calls without `tabId` use it.
2. A tab is owned by at most one session; parent/child cannot act on each
   other's tabs without `tabs.transfer` → `tab_not_owned`.
3. Per-tab async mutex serialises page calls; different tabs run in parallel.
4. Lease expiry (60 s with no call/heartbeat) = `session.close` with no keep.
5. Daemon start reconciles: tabs in agent groups without a live lease are
   closed (unless the user is looking at it); `orphans_closed` to the parent.
6. Owned tabs: 1440x900 metrics override, `Page.setWebLifecycleState{active}`,
   auto-attach OOPIFs (`flatten`). Borrowed tabs: no metrics override.
7. Focus emulation (`Emulation.setFocusEmulationEnabled`) only during
   `act` / `navigate` / `snapshot`.
8. Never `Runtime.enable` / `Debugger.enable` on agent pages.

## Seams (between streams) — `src/seams.ts`

- `TabCdp{tabId, targetId, send(method, params, {sessionId?, timeoutMs?}), on(event, handler)}` — WS-C.
- `FrameHandle{ordinal, frameId, sessionId?, utilityContextId, origin}` — WS-C.
- `PageContext{sessionId, cdp, frames(), callInjected(frame, method, args), resolveRef(ref), emit(event), artifactDir, previousTree?}` — WS-C builds one per call under the tab mutex; WS-D (`snapshot/`) and WS-E (`actions/ wait/ input/ screenshot/ files/`) consume it.
- Module entry points: `takeSnapshot(page, params)` (WS-D), `act(page, params)`,
  `performActionAndWait(page, action)`, `screenshot(page, params)` (WS-E).

## Injected-world API — `src/injected/api.ts`

Installed as `globalThis.__obu` in isolated world `__obu_utility` of every frame:

```ts
version
takeSnapshot({interactive?, ref?, selector?, showHidden?, maxDepth?=50, frameOrdinal}) -> {yaml, refs, iframes:[{ref, frameName?, src}]}
deref(ref) -> Element|null                // cache first, then role+name+nth over ≤5000 nodes
waitForReady(ref, {timeoutMs, enabled?, editable?}) -> {ok:true, rect} | {ok:false, reason}
checkHitTarget(ref, x, y) -> {ok, hit?}   // elementFromPoint through shadow roots
resolvePointerTarget(x, y) -> {ref?, tag}
checkEditable(ref) -> boolean
settleProbe() -> {readyState, interactiveCount, textLen, mutationRatio, landmarks}
annotate(on)                              // red numbered boxes per ref, z-index 2147483647
```

WS-C injects with `Page.addScriptToEvaluateOnNewDocument{worldName}` +
`Page.createIsolatedWorld`, health-checks `__obu.version`, re-injects on
context destroy (10 tries × 200 ms).

## Behaviour spec

### Snapshot (WS-D)

- DOM walk in the isolated world (not `Accessibility.getFullAXTree`):
  `childNodes`, open `shadowRoot`s, `aria-owns` targets, `::before/::after`
  text; max depth 50; skip script/style/meta/noscript/template.
- Visibility cached per snapshot, walks up through shadow hosts; content
  below the fold is **kept** (agents never scroll).
- Interactive: native interactive tags, `onclick`, tabindex ≠ -1, role
  button/link/etc., contenteditable, `cursor:pointer` not inherited from parent.
  Scrollables and landmarks kept.
- Refs only on interactive nodes: `eN`, `fKeN` in iframe K. Cached on the
  element (Symbol/WeakMap) keyed by (role, name) → stable across snapshots.
- Accessible name: W3C-style, depth ≤ 10, cut to 100 chars.
- Compaction: merge adjacent text; unwrap empty generic wrappers; drop hidden
  ref-less subtrees; fold ≤ 3 leaf texts into parent name; assert unique refs.
- Output: Playwright-style YAML, header `- title: "…" [url=…]`; markers
  `[focused] [checked] [disabled] [expanded] [selected]`; passwords `[redacted]`.
- Over `maxChars` → `snapshot_too_large` with advice. Never truncate.
- Frames in parallel, each in its own isolated world, stitched under
  `- iframe [ref=…] [origin=…]`; main frame retried 3×; snapshots of one
  page serialised.
- `{tree, diff}`: unified diff vs previous snapshot of (session, tab).

### Input (WS-E)

- Actionability (default 5 s): attached, visible, enabled, stable = same box
  32 ms apart timed with `setTimeout` (not rAF); retries at 0/100/200 ms.
- Click: `DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads` → hit test
  (`checkHitTarget`, iframe offsets) → `Input.dispatchMouseEvent`
  moved/pressed/released. Verify + fallbacks: obscured → DOM `.click()`;
  checkbox → confirm `checked` flipped; disclosure still
  `aria-expanded=false` after 80 ms → DOM click; hidden checkbox/radio →
  click its label.
- Coordinate actions on hidden/unfocused tabs synthesize DOM
  `MouseEvent`/`WheelEvent` at `elementFromPoint`.
- Keys: `Input.dispatchKeyEvent` with Mac editing `commands`
  (`selectAll copy paste cut undo redo`), `ControlOrMeta` → Meta on darwin;
  `Input.insertText` for newline/emoji/CJK; `fill` sets value directly for
  date/time/color/range; `select` by value or label.
- Drag: synthetic `DragEvent`s sharing one `DataTransfer`.
- Upload: fast path `Page.setInterceptFileChooserDialog` +
  `DOM.setFileInputFiles`; fallback without file-URL access = daemon reads the
  file, sends base64 chunks into the isolated world, builds `File` →
  `DataTransfer` → `input.files`, fires `input` + `change` (also drop zones);
  2 s fallback for iframe-hosted inputs.
- Downloads: `Page.downloadWillBegin/downloadProgress` per tab session,
  correlated with `chrome.downloads` by url + time → absolute path.

### Settle — `performActionAndWait` (WS-E; constants in `src/wait/index.ts`)

1. Track network per tab, ignoring WebSocket, EventSource, Ping, Prefetch, CSP reports.
2. Wait for `readyState` to leave `loading`.
3. Wait 150 ms, then give requests started by the action up to 1.2 s.
4. Main-frame navigation: probe every 100 ms; ready = visible interactive
   elements, landmarks, or ≥ 20 chars text; network quiet 1.5 s; +≤ 1 s if 0
   interactive (redirect guard).
5. URL-only change (SPA): 500 ms, then settle ≤ 750 ms.
6. Otherwise: settle ≤ 300 ms, ending early when the MutationObserver ratio
   < 1%; 350 ms quiet window sampled twice; network poll every 50 ms.
7. Cap 8 s. Timeout = warning in `settled.warning`, not an error.

### Screenshots (WS-E)

`Page.captureScreenshot` JPEG q70, scaled to ≤ 1280 px wide, written to a
file; if capture hangs > 2 s (hidden tab), `Page.startScreencast` one frame
then stop. `annotate` wraps the capture in `__obu.annotate(true/false)`.

### Dialogs (WS-C)

Auto-accept `alert`/`beforeunload`; accept `confirm` and report; dismiss
`prompt` and report — unless a `wait{for:'dialog', dialogAction}` is pending.
Never leave a tab hung on a dialog.
