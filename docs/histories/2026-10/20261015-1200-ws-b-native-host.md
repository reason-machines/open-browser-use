# WS-B: native host relay, auth, chunking, agent supervision

- Relay rewrites only the top-level JSON-RPC `id` with a byte-level scanner
  (`internal/wire/jsonscan.go`); no `map[string]any` round trip.
- Host→extension messages over 900 KB are split into base64 chunk envelopes
  (`internal/wire/chunk.go`); extension→host chunks are reassembled.
- Socket auth: same-uid peer check + `relay.token` handshake
  (`OBU_RELAY_AUTH=uid` opts out). Go CLI dials via `host.DialRelay`.
- `params.timeoutMs` passthrough: CLI fills it from `--timeout`; the relay
  answers with a typed timeout after `timeoutMs + 2 s`.
- Live sockets are never unlinked on non-stale dial errors (cherry-picked
  upstream PR #24 for #22; relay's own pinned path uses the same guard).
- `obu-agent` supervisor (`cmd/open-browser-use/agent_supervisor*.go`):
  spawn per profile, restart backoff 0/250/750/1500/3000 ms, adopt a running
  agent, records in `active.json` + `agents/<profile>.json`.
- Measured (in-process echo, 2 MB response round trip): p50 8.27 ms → 1.10 ms.
  Live headless CfT 153, `Runtime.evaluate` returning 2 MB: p50 ~56 → ~43 ms.
