# Cross-stream backlog

One line per item: `- [owner] item (raised by <stream>, <date>)`.
- [WS-B→A,C,SDKs] Relay now requires `{"auth":"<token>"}` (`relay.token` next to the socket) unless `OBU_RELAY_AUTH=uid`; extension must reassemble `{"chunk":{id,i,n,data(base64)}}` (contract.md §Native host); obu-agent should read `OBU_RELAY_SOCKET`/`OBU_RELAY_TOKEN_PATH`, re-read `active.json` on relay loss; JS/Python/Go SDKs need the auth frame (Go CLI uses `host.DialRelay`).

## From Round 1 merges
- [snapshot] Interactive snapshots of Wikipedia/Amazon exceed 40K chars default; add aggressive interactive compaction (collapse repeated link lists, viewport-first + "N more" summaries) so interactive ≤ ~8K chars on heavy pages. Closed shadow roots unsupported.
- [host] Relay token auth on by default breaks JS/Python/Go SDKs until they send the auth frame (OBU_RELAY_AUTH=uid opt-out). Daemon must read OBU_RELAY_* and re-read active.json on relay drop. Chunked host→extension needs live test after WS-A.
