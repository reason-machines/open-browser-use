# Round 1 workstreams

Ownership is disjoint. Streams talk only through `packages/obu-agent/src/contract.ts`,
`src/seams.ts` and `src/injected/api.ts`, and mock each other where needed.
Base every clone on `main` at or after the round-0 commit. Rules: `PLAN.md`.

Shared "may touch" for every stream: append one line to `docs/agent/BACKLOG.md`;
add your own `docs/histories/YYYY-MM/…` file; add (never reorder) your own
test files under `packages/obu-agent/test/<stream>-*.test.mjs`.

---

## WS-A Extension — branch `r1-extension`

- **Owns:** `apps/chrome-extension/**`, `scripts/package-chrome-extension*.{sh,mjs}`.
- **May touch:** `scripts/ci.sh` (add test globs only).
- **Must not touch:** `packages/obu-agent/src/**` except reading the contract; `internal/**`.
- **Deliver:**
  1. `executeCdp` accepts `sessionId` (flat child session via `chrome.debugger` `DebuggerSession.sessionId`, Chrome ≥ 125); `onCDPEvent` carries `sessionId`. Verify on Chrome for Testing + user's stable Chrome.
  2. Implicit attach inside `executeCdp` (no separate `attach` round trip).
  3. Per-client subscription `subscribe{tabId, domains[]}` replacing broadcast of all CDP events.
  4. Groups: one per root agent session, title `<label> · Reason`, muted colour; `tabs.create({active:false})` into bound window (last-focused → only → focused); group mutations through a promise queue; **close guard** (only if still in group and not the active tab of the focused window); group exit (`onUpdated`/`onMoved`) emits `leaseRevoked{tabId}`.
  5. Popups: `tabs.onCreated` with `openerTabId` of a session tab emits `popupOpened{tabId, openerTabId}`.
  6. Dialogs: forward `Page.javascriptDialogOpening` (daemon decides policy).
  7. Downloads: `onCreated/onChanged` events carry `referrer`, `url`, `startTime`, `tabId` guess.
  8. Keepalive `chrome.alarms` 30 s; every request carries `route{profileId}`; mismatch rejected.
  9. Chunking: frames > 900 KB host→ext as `{chunk:{id,i,n,data}}`, reassembled (pair with WS-B).
  10. Branding from build config `OBU_BRAND` (ids, native host name, group suffix).
- **Acceptance:** `node --test apps/chrome-extension/*.test.mjs` green incl. new unit tests for each item; live (CfT or user Chrome via own session): 4 sessions × 2 tabs land in correct groups with user's active tab + frontmost window unchanged; drag-out → `leaseRevoked` < 500 ms; 5 MB evaluate round-trips; OOPIF child session `Runtime.evaluate` in isolated world via `sessionId`.

## WS-B Native host (Go) — branch `r1-host`

- **Owns:** `internal/host/**`, `internal/wire/**`, `cmd/open-browser-use/main.go` (host/relay/socket code paths), new `cmd/open-browser-use/agent_supervisor*.go`.
- **May touch:** `go.mod`/`go.sum` (stdlib preferred).
- **Must not touch:** `cmd/open-browser-use/iab*.go`, `mcp*.go` beyond compile fixes; `apps/**`; `packages/**`.
- **Deliver:** relay rewrites only `id` via `json.RawMessage` (no full decode); chunk split/reassembly matching WS-A; socket auth (`getpeereid` same uid + token file); never unlink a live socket (EPERM, upstream #22/#23/#24); `timeoutMs` passthrough; supervise `obu-agent` (spawn, restart backoff 0/250/750/1500/3000 ms); `active.json` records the per-profile agent socket.
- **Acceptance:** `go build ./... && go test ./...`; extended `relay_test.go`; bench: p50 relay overhead for a 2 MB message < 3 ms; other-uid / no-token connection refused; kill `obu-agent` → back < 1 s.

## WS-C Daemon core — branch `r1-daemon`

- **Owns:** `packages/obu-agent/src/{daemon,session,lease,store,cdp,server,mcp}/**`, `src/errors.ts`, `src/events.ts`, `src/index.ts`, `packages/obu-agent/package.json`.
- **May touch:** `src/contract.ts` / `src/seams.ts` (additive only, mirrored in `docs/agent/contract.md`).
- **Must not touch:** `src/{injected,snapshot,actions,wait,input,screenshot,files}/**` (mock them).
- **Deliver:** full JSON-RPC handler table per contract; MCP `--attach` proxy with static schemas; SQLite store (prefer `node:sqlite`; fall back to a JSON file store if unavailable — no native deps); leases 15 s / 60 s + finalize; reconcile on start (I5); per-tab mutex (I3, `KeyedMutex` exists); host connection via the OBU socket (`/tmp/<brand>-browser-use/active.json`) using raw `executeCdp`/`createTab`/`finalizeTabs` until WS-A lands child sessions; `PageContext` implementation (A3 attach sequence minus `Runtime.enable`, owned-tab metrics override, isolated world injection + health check, focus emulation per call); dialog policy; `SystemEvent` queue with `seq` + `session.events` long-poll; profile lock; token auth.
- **Acceptance:** unit tests for lease expiry (fake clock), reconcile, mutex, transfer, `tab_not_owned`; live: two sessions acting on different tabs run concurrently (wall ≈ max); `kill -9` of a client mid-task → owned tabs closed within 60 s, borrowed tabs stay; `alert()` on fixture never hangs and appears in the next result.

## WS-D Snapshot engine — branch `r1-snapshot`

- **Owns:** `packages/obu-agent/src/injected/**`, `src/snapshot/**`, `packages/obu-agent/test/golden/**`, a bundling script `packages/obu-agent/scripts/build-injected.mjs`.
- **May touch:** `packages/obu-agent/package.json` scripts (add `build:injected`, chain into `build`).
- **Must not touch:** WS-C/WS-E dirs.
- **Clean room:** Playwright Apache-2.0 aria/roleUtils + our engine; never read or copy Aside bundles.
- **Deliver:** `__obu` per `injected/api.ts` and the snapshot spec in `contract.md`; `takeSnapshot(page, params)`, `stitchFrames`, `unifiedDiff`, `withAnnotations`.
- **Acceptance:** golden YAML for the 12+ fixture pages (run injected code in real Chrome via CDP or in jsdom-free headless CfT); refs identical across two snapshots of unchanged page; single-node mutation → one-line diff; p50 < 60 ms on the 2,000-node fixture, < 150 ms on a saved real-world page; ≥ 50% smaller than `innerText` + raw AX dump.

## WS-E Actions, waiting, screenshots, files — branch `r1-actions`

- **Owns:** `packages/obu-agent/src/{actions,wait,input,screenshot,files}/**`.
- **May touch:** nothing else (mock `PageContext`; call `__obu` via `page.callInjected`).
- **Deliver:** everything in contract.md §Input, §Settle, §Screenshots, uploads/downloads.
- **Acceptance:** fixture e2e on owned **background** tabs while another tab is focused (user foreground unchanged); Cmd+A/C/V in textarea; emoji + CJK exact in contenteditable; upload with file-URL access off; download path belongs to triggering tab under concurrent downloads; click p50 < 300 ms incl. settle on static page; background screenshot ≤ 3 s always; SPA route change settles without sleeps.

## WS-F Product integration — `reason-machines/monorepo`, `.worktrees/browser-daemon`

- **Owns:** see PLAN.md D5 WS-F list (tool family `browser_*`, Mac path via daemon socket, cloud resident daemon, subagent sessions + finalize, ≤ 1.5K-token prompt, telemetry).
- Codes against a mock daemon generated from `contract.ts` (import `obu-agent/contract`).
- **Acceptance:** `bun run test:integration` green; mac dogfood smoke: parent + 3 subagents each own a tab, act in parallel, finish with no leftover tabs/groups; Mac per-call overhead outside daemon p50 < 20 ms.

## WS-G Fixtures, e2e, bench — branch `r1-bench`

- **Owns:** `packages/obu-agent/fixtures/**`, `packages/obu-agent/e2e/**`, `bench/**`.
- **Deliver:** every page in `fixtures/pages.mjs`; e2e runner (CfT headful on Mac with fork extension via `--load-extension` + dev native host; `E2E_REAL_PROFILE=1` runs against the user's Chrome via an owned session); bench p50/p95/p99 for `open_tab`, snapshot (interactive/full), click, fill, type 50 chars, screenshot, background screenshot, 4-agent parallel throughput → `bench/results/<sha>.json`, compared with `bench/baseline.json`; a hard-task suite runner (agent-level tasks, our stack vs Aside).
- **Acceptance:** suite runs locally on macOS; `node bench/compare.mjs` prints a comparison table.
