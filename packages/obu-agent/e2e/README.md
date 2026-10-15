# obu-agent e2e + micro-bench (WS-G)

```bash
pnpm --filter obu-agent e2e            # all suites; pending (todo) where the daemon isn't there yet
pnpm --filter obu-agent e2e:strict     # merge gate: every pending counts as a failure
pnpm --filter obu-agent e2e:fixtures   # fixture self-test only (raw CDP, no daemon)
E2E_SUITES=actions,files pnpm --filter obu-agent e2e
pnpm --filter obu-agent bench:micro    # -> e2e/bench/results/<sha>.json
pnpm --filter obu-agent bench:compare  # table vs repo bench/baseline.json + PLAN D6 targets
node fixtures/server.mjs               # browse the fixture site (localhost:47110 + 127.0.0.1:47111)
```

## What the harness starts (default, macOS)

1. Fixture servers on two origins (cross-origin iframes become OOPIFs).
2. Go host built from `cmd/open-browser-use` into a temp dir; a wrapper runs
   `open-browser-use host --socket-path <tmp>/host.sock`, registered in
   `<tmp>/profile/NativeMessagingHosts/` **before** Chrome starts.
3. Chrome for Testing (newest under `~/Library/Caches/ms-playwright` or
   `~/.cache/puppeteer`, or `E2E_CHROME`), headful (`E2E_HEADLESS=1` for
   `--headless=new`), throwaway `--user-data-dir`, `--load-extension=apps/chrome-extension`,
   CDP on the first free port in 9460–9469. The extension's file-URL access is
   **revoked** (D6 #5; `E2E_FILE_URL_ACCESS=on` keeps it).
4. `node dist/daemon/main.js --profile e2e --socket <tmp>/agent.sock --host-socket <tmp>/host.sock`
   with env `OBU_HOST_SOCKET`, `OBU_AGENT_SOCKET`, `OBU_DOWNLOADS_DIR`, `OBU_BRAND_DIR`
   (**WS-C:** accept `--host-socket`/`OBU_HOST_SOCKET` to reach the dev host; or set
   `E2E_DAEMON_CMD` to launch differently).

Teardown (top-level `after` in `all.test.mjs`, plus signal/exit handlers): close every
page target, `Browser.close`, kill Chrome + daemon, close servers, delete the temp dir.
User rule: no orphan Chromes or tabs, ever — check with `ps -ef | grep obu-e2e`.

Other modes: `OBU_AGENT_SOCKET=<path>` attaches to a running daemon;
`E2E_REAL_PROFILE=1` drives the user's Chrome through an owned session on the user's
daemon (no CfT, ground truth via `evaluate` world `page`; raw-CDP-only tests pend).
`E2E_SLOW=1` enables the 60 s lease-expiry test. `E2E_DEBUG=1` traces setup/teardown.

## Pending policy

`not_implemented` (and, outside strict mode, `extension_disconnected` / "extension not
connected" / daemon unavailable) turns a test into **todo** with the reason. Once a
stream lands, its tests start passing or failing for real; `E2E_STRICT=1` is the gate.

## Suites

| suite | covers |
|---|---|
| fixtures | every page loads clean, `__fx` present, OOPIF + nested frame, feed, shadow, probes |
| sessions | daemon.info, idempotent open, heartbeat, unknown_session, background open w/o focus theft, list scopes, I1, I2 + transfer, close/keep/borrowed (no leftovers), 4 parallel sessions, cdp denylist (I8), user-closed tab event, I4 lease (E2E_SLOW), I5 restart reconcile |
| snapshot | header/roles/refs, password redaction, stability, one-line diff, frames + fKeN, open/nested/slotted shadow, hidden vs below-fold, aria-owns, pointer divs, scoping, snapshot_too_large, perf p50 < 60 ms, size vs innerText + AX |
| actions | full form, emoji/CJK/RTL exact, Cmd+A/C/V, Enter, hover, obscured fallback, glass, disclosure, moving, canvas coords, DnD + slider, date pickers, selects/listbox/combobox, OOPIF + nested, shadow (closed = stretch), SPA settle + back, slow XHR + wait text, spinner cap, infinite scroll needle, stale_ref, not_actionable, click p50 < 350 ms |
| events | alert/confirm/prompt policy, wait{dialog} answer, beforeunload, `<dialog>`, popups adopted + closed with session, OAuth popup flow |
| files | uploads (input, hidden styled, multi, drop zone, iframe) w/o file-URL access, concurrent per-tab downloads, download kinds, screenshots (bg, annotate, element, full page), evaluate worlds |
| stealth | I6 1440x900 coherent viewport, borrowed untouched, focus-theft sentinel under load, I7, I8 tells |
