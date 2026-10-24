# Clear open code-scanning alerts

Request (condensed): fix or triage all open GitHub code-scanning alerts in this repository.

- **Extension ZIP unpack (go/zipslip):** `unzipExtension` also requires `filepath.IsLocal(entry)` before the existing escaped-path check, so absolute, `..` and Windows-reserved names are refused before they are joined.
- **Go client frames (go/allocation-size-overflow):** `EncodeFrame` refuses payloads over `wire.DefaultMaxFrame`, the limit the relay applies when reading, so the 4-byte length and the allocation cannot overflow.
- **Snapshot link text (js/incomplete-url-scheme-check):** `shortUrl` hides `data:` and `vbscript:` hrefs as it already hid `javascript:`.
- **Fixture server (js/resource-exhaustion):** the `ms` delays on `/download/file.txt` and `/slow` are capped at 60 s.
- The remaining alerts (JSON.stringify values embedded in CDP-evaluated code, RS256 JWT signing, the e2e daemon command override) were dismissed on GitHub with reasons.

Files: `cmd/open-browser-use/main.go`, `packages/open-browser-use-go/client.go`, `packages/obu-agent/src/injected/runtime.ts`, `packages/obu-agent/fixtures/server.mjs`.
