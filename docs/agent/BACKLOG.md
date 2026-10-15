# Cross-stream backlog

One line per item: `- [owner] item (raised by <stream>, <date>)`.
- [WS-B→A,C,SDKs] Relay now requires `{"auth":"<token>"}` (`relay.token` next to the socket) unless `OBU_RELAY_AUTH=uid`; extension must reassemble `{"chunk":{id,i,n,data(base64)}}` (contract.md §Native host); obu-agent should read `OBU_RELAY_SOCKET`/`OBU_RELAY_TOKEN_PATH`, re-read `active.json` on relay loss; JS/Python/Go SDKs need the auth frame (Go CLI uses `host.DialRelay`).
