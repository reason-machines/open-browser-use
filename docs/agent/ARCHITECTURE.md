# Agent-browser architecture (decisions)

Decided once in round 0. Streams do not re-decide; propose changes via `BACKLOG.md`.

## Process layout

```
agent tool call ─► obu-agent (resident, one per Chrome profile)
                     unix socket ~/Library/Application Support/Reason/browser/<profile>/agent.sock (0600 + token)
                     JSON-RPC 2.0 NDJSON  |  MCP stdio via `obu-agent mcp --attach`
                     │ owns: sessions, leases, SQLite, per-tab mutex, CDP sessions,
                     │       snapshot stitch/diff, actions, settle, screenshots, files
                     ▼
                   native host (Go, decode-free relay; spawns + supervises obu-agent)
                     ▼ Chrome native messaging (chunked > 900 KB)
                   MV3 extension (chrome.debugger + tabs/tabGroups/downloads)
                     ▼
                   user's real Chrome profile
```

## D0 decisions

1. **Transport stays extension + native host** (only silent route into the
   user's real profile on stock Chrome). Direct CDP via the Chrome 144+
   remote-debugging toggle is a round-2 spike (prompts per connection, shows
   automation banner). The relay hop is ~0.3 ms (BASELINE.md) — not the bottleneck.
2. **Owned tabs get `Emulation.setDeviceMetricsOverride{1440x900, dsf 0}`**;
   borrowed tabs never. A measured viewport < 960x540 = not laid out yet.
3. **Ownership truth lives in the daemon** (SQLite). The tab group is the
   user-visible signal and a revocation signal (drag-out = revoke).
4. **Tool shape:** round 1 ships fat structured tools (`browser_*` over
   `snapshot/act/navigate/...`); round 2 adds a Playwright-compatible
   `browser_repl` on the same action layer.
5. **Snapshot engine is clean-room** (Playwright Apache-2.0 aria code +
   our engine), behaviour per the spec in `contract.md`.
6. **Never `Runtime.enable` / `Debugger.enable`** on agent pages. Evaluate in
   the isolated world `__obu_utility` by `executionContextId` from
   `Page.createIsolatedWorld`.

## D1 where code lives

| Piece | Home |
|---|---|
| Extension: child sessions, implicit attach, subscriptions, groups + close guard, popups, dialogs forwarding, downloads correlation, keepalive, routing, chunking, branding | this fork, `apps/chrome-extension/` |
| Native host: decode-free relay, auth, chunking, EPERM fix, timeout passthrough, daemon supervision | this fork, `internal/host/`, `internal/wire/`, `cmd/open-browser-use/` |
| `obu-agent` daemon | this fork, `packages/obu-agent/` (TypeScript; shipped as Node SEA or `bun build --compile`) |
| Branding | build-time config `OBU_BRAND` (replaces `replaceAll` patching downstream) |
| Tool definitions, prompts, subagent policy, run-end finalize, telemetry, billing | product repo (`reason-machines/monorepo`) |

## D3 Rust verdict

Not now. Per-step seconds come from process spawn (CLI p50 133 ms measured),
probes, missing fat actions, readyState polling, focus hacks — all
architectural. The socket hop is p50 0.35 ms. **Gate (round 2):** port the
host relay to Rust only if transport-only share of a click round trip is
> 5 ms at p95 over 500 runs **and** > 10% of action time after the daemon
fixes. No Rust daemon (REPL + injected snapshot engine are JS).

## Cross-cutting conventions

- **Errors:** JSON-RPC error with `error.data: ObuErrorData{code,…}`; message
  goes to the agent verbatim and must say what to do next.
- **IDs:** `tabId` = chrome tab id; `targetId` = CDP target; refs `eN` / `fKeN`.
- **Events:** `SystemEvent` with per-session `seq`; appended to every result
  and pullable via `session.events{afterSeq}`; rendered as `[system] …`.
- **Artefacts:** files under the session's artefact dir; results carry paths,
  never base64 images.
- **Timeouts:** settle timeouts are warnings; actionability/CDP timeouts are
  `timeout{stage}` errors.
