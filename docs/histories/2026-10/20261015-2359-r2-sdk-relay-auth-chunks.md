# r2-sdk: SDK relay auth, chunk format, event routing, Rust gate

- JS/Python/Go SDKs and the CLI send `{"auth":token}` (token path precedence:
  `OBU_RELAY_AUTH=uid` → none, `OBU_RELAY_TOKEN_PATH`, explicit/`active.json`
  `tokenPath`, `<socket dir>/relay.token`), reassemble `{chunk}` envelopes,
  and surface relay-level (`id:null`) errors.
- Host chunk format switched from base64 byte slices to JSON-text slices on
  UTF-8 rune boundaries, matching the extension's `ChunkAssembler`
  (`JSON.parse(parts.join(""))`); the base64 form was never decodable there.
- Relay routes `onCDPEvent` by `params.subscribers` and session-scoped
  notifications by `params.sessionId`.
- Live: `internal/host/live/run-live-relay.mjs` (real Go host + extension in
  CfT): 2 MB/2.5 MB chunked requests and responses, SDK smokes, Rust gate
  (transport p95 0.61 ms → no port; docs/agent/RUST-GATE.md).
