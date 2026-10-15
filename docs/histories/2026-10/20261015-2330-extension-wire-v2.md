# Extension wire v2 (WS-A)

## Request

Round-1 extension stream: make the Chrome extension a solid substrate for the
obu-agent daemon — child CDP sessions, implicit attach, event subscriptions,
per-root-session tab groups with a close guard, popup adoption, dialog and
download forwarding, keepalive/routing, chunked frames, build-time branding.
User asks folded in: no "Task - OBU ✅" group labels (brand mark only, one
colour), minimise Chrome's debugging infobar, close agent tabs on session end
or lease expiry, quit every test Chrome.

## Changes

- `apps/chrome-extension/background.js`: wire v2 (see `WIRE.md`): implicit
  idempotent attach, `target.sessionId`, `subscribe/unsubscribe`, `closeTab`,
  `getTargetId`, `configure`; groups per root session, subagent tab
  isolation, bound window, queued group mutations, close guard;
  `leaseRevoked`, `tabClosed`, `popupOpened` (+ focus hand-back),
  `debuggerAttached/Detached`, `sessionExpired`; idle detach (30 s);
  extension lease backstop (5 min); download→tab correlation; `route`
  check with typed errors; chunk reassembly; `@obu-brand` block; cursor
  overlay publish no longer blocks `createTab`.
- `apps/chrome-extension/brands/*.json`, `scripts/package-chrome-extension-brand.mjs`
  (+ test), `scripts/package-chrome-extension.sh`: `OBU_BRAND` / `OBU_BRAND_FILE`.
- Tests: `agent-wire.test.mjs` (28 cases) on an in-memory chrome fake;
  `live/run-live.mjs` + `live/test-host.mjs` drive Chrome for Testing.
- `docs/agent/contract.md` transport note; `docs/agent/BACKLOG.md` lines.

## Verification

Unit: all `apps/chrome-extension/*.test.mjs` and the brand test pass.
Live (CfT 153, throwaway profile, `--brand reason`): 20/20 — 8 tabs for 4
sessions in 4 `Reason`/grey groups in ~70 ms with the user's tab and frontmost
app unchanged; implicit attach+eval 3–12 ms, warm eval p50 0.5 ms; 5 MB result
~340 ms; 2.5 MB chunked request ~110 ms; OOPIF isolated-world eval via child
`sessionId`; drag-out → `leaseRevoked` in 4–9 ms; popup adopted and user tab
re-activated; download tagged with tab/session; profile mismatch rejected;
finalize closes owned tabs and releases the one being viewed. Stable Chrome
154 ignores `--load-extension`, so it is not covered live.
