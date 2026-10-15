# Rust gate (PLAN D3) — measured 2026-10-15

**Verdict: do not port the native host/relay to Rust.** Both gate conditions
fail by a wide margin.

| Gate condition (PLAN D3) | Threshold | Measured | Pass? |
|---|---|---|---|
| Transport-only share of a click round trip, p95 | > 5 ms | 0.61 ms per round trip (1.22 ms for the two a click needs) | no |
| …as a share of action time after daemon fixes | > 10 % | 0.6 % of click+settle (196 ms p95, WS-E) | no |

## Setup

`node internal/host/live/run-live-relay.mjs` — the real Go host binary
(`./cmd/open-browser-use`, token auth on, `OBU_AGENT=off`) registered as the
`reason` brand's native host in a throwaway Chrome for Testing 153 profile
(headless=new), the merged WS-A extension, Apple Silicon Mac. 500 runs after
20 warm-up runs, one persistent client socket.

## Numbers

| Measure | p50 | p95 |
|---|---|---|
| Transport round trip (`getInfo`: client socket → relay → native messaging → extension service worker → back; no CDP) | 0.251 ms | 0.610 ms |
| Raw CDP click (`Input.dispatchMouseEvent` pressed + released via `executeCdp`, 2 round trips) | 1.009 ms | 2.186 ms |
| Transport share of the raw click, p95 | | 55.8 % |
| Daemon click incl. actionability + settle (WS-E, headful CfT) | 192 ms | 196 ms |
| Relay's own cost, in-process (WS-B bench: small / 2 MB) | 0.015 ms / 1.10 ms | 0.040 ms / 1.40 ms |

Transport is over half of a *raw* CDP click, but a raw click is ~1 ms; the
agent-visible action is dominated by actionability checks and settle waiting
(~190 ms), page work, and model turns (seconds). A Rust relay could save at
most the relay's own ~0.02 ms of the 0.25 ms round trip — the rest is Chrome's
native-messaging pipe and the service worker, which no host language changes.

Large payloads (same run): 2 MB response 43/51 ms, 2 MB request (chunked)
39/52 ms, 2.5 MB multi-byte round trip 261/578 ms (p50/p95) — dominated by
Chrome's JSON handling in the extension, not the relay (1.1 ms in-process).

## Re-run

`node internal/host/live/run-live-relay.mjs` (ports 9490/9491) runs
`TestLiveRelay` + `TestLiveRustGate` and the JS/Python SDK smokes against the
real relay, then quits Chrome and deletes the profile. Reconsider only if a
future transport (e.g. direct CDP fast mode) moves the bottleneck into the
host process, or for distribution size.
