# Cross-stream backlog

One line per item: `- [owner] item (raised by <stream>, <date>)`.
- [WS-B→A,C,SDKs] Relay now requires `{"auth":"<token>"}` (`relay.token` next to the socket) unless `OBU_RELAY_AUTH=uid`; extension must reassemble `{"chunk":{id,i,n,data(base64)}}` (contract.md §Native host); obu-agent should read `OBU_RELAY_SOCKET`/`OBU_RELAY_TOKEN_PATH`, re-read `active.json` on relay loss; JS/Python/Go SDKs need the auth frame (Go CLI uses `host.DialRelay`).

## From Round 1 merges
- [snapshot] Interactive snapshots of Wikipedia/Amazon exceed 40K chars default; add aggressive interactive compaction (collapse repeated link lists, viewport-first + "N more" summaries) so interactive ≤ ~8K chars on heavy pages. Closed shadow roots unsupported.
- [host] Relay token auth on by default breaks JS/Python/Go SDKs until they send the auth frame (OBU_RELAY_AUTH=uid opt-out). Daemon must read OBU_RELAY_* and re-read active.json on relay drop. Chunked host→extension needs live test after WS-A.
- [WS-A] Daemon expects from the extension: `executeCdp` honouring `target.sessionId` (flat OOPIF sessions), `onCDPEvent.source.sessionId`, notifications `popupOpened{tabId,openerTabId,url}`, `leaseRevoked{tabId,reason}`, `tabClosed{tabId}` (until then the daemon polls `getTabs` every 3 s), a `closeTab` RPC (daemon uses `Page.close` today), and `getTabs` entries with `active` + window-focused for the I5 close guard. (raised by WS-C, 2026-10-15)
- [WS-E] Daemon calls `performActionAndWait(page, action)` for `navigate` (default `waitUntil:'settled'`), `tabs.open` and `wait{for:'settled'}`; `wait{for:'download'}` resolves on `download_finished` events — emit them from `files/` via `page.emit`. (raised by WS-C, 2026-10-15)
- [WS-F] Use `obu-agent mcp --attach --session <runId> [--parent <parentRunId>]` per (sub)agent, or `ObuAgentClient` with the token; call `browser_finish` / `session.close` at run end. (raised by WS-C, 2026-10-15)
