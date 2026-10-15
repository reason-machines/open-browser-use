# Baseline: today's OBU path on this Mac (round 0)

Measured 2026-10-15 on darwin-arm64 against the installed OBU 0.1.42 (Reason
desktop build) extension + Go native host, user's real Chrome, via a
persistent socket from `bench/baseline.mjs` (SDK `OpenBrowserUseClient`).
Page: a tiny local HTTP page opened in the bench's own background session
tab; tabs finalized (closed) at the end. Raw data: `bench/baseline.json`.

Re-run: `pnpm --filter open-browser-use-sdk build && node bench/baseline.mjs`.

| Op | n | p50 ms | p95 ms | max ms | Notes |
|---|---|---|---|---|---|
| `ping` (persistent socket) | 50 | 0.35 | 36.1 | 560 | transport floor: socket → host → NM → SW |
| `getInfo` | 50 | 0.55 | 6.1 | 91 | |
| **open_tab → loaded** (createTab + attach + Page.navigate + readyState poll 100 ms) | 20 | **1354** | **4101** | 4101 | today's agent "open a page" path |
| `getTabs` | 50 | 6.1 | 103 | 184 | tab-group re-query per call |
| attach + `Runtime.evaluate` | 50 | 33.3 | 1231 | 1931 | attach sent before every cdp call (current agent pattern) |
| `Runtime.evaluate` (already attached) | 50 | 6.8 | 77.5 | 248 | |
| raw CDP click (pressed + released) | 50 | 19.5 | 366 | 756 | no actionability, no settle |
| `Page.captureScreenshot` PNG, background tab | 20 | 341 | 837 | 837 | did not hang this run (OBU #30 is intermittent / window-state dependent) |
| `Page.captureScreenshot` JPEG q70, background tab | 20 | 187 | 359 | 359 | |
| CLI spawn `obu ping` | 20 | 133 | 191 | 191 | process-spawn tax paid per tool call today |

## Reading

- Transport is not the problem: p50 0.35 ms per round trip. The Rust gate in
  ARCHITECTURE.md is far from triggered.
- The cost is architectural: **process spawn ~133 ms per call**, open-tab
  path ~1.35 s p50 / 4.1 s p95 driven by readyState polling and the extra
  attach, attach-per-call adding p95 > 1.2 s, and agents having no fat
  actions (each "click" is several model turns of hand-written CDP).
- Targets (ARCHITECTURE/PLAN D6): open_tab < 700 ms, interactive snapshot
  < 100 ms, click incl. settle < 350 ms, background screenshot < 400 ms p50.

Not measured here (needs the product repo, WS-F/WS-G): full Mac tool call
via `cli/mac-automation.ts` (adds the `profiles --connected` probe + post-call
`tabs` lookup) and the cloud `node --eval` path.
