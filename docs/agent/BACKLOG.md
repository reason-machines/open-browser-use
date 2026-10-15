# Cross-stream backlog

One line per item: `- [owner] item (raised by <stream>, <date>)`.
- [WS-B] host→extension chunking must match `apps/chrome-extension/WIRE.md` (`{chunk:{id,i,n,data}}`, data = string slices of the JSON text, each frame < 1 MB); route notifications by `onCDPEvent.subscribers` when present (raised by WS-A, 2026-10-15)
- [WS-C] consume wire v2: re-run attach sequence on `debuggerAttached`; map `leaseRevoked`/`tabClosed`/`popupOpened`/`sessionExpired` to SystemEvents; pass `parent_session_id` for subagents; send `route.profileId` from `getInfo().metadata.profileId` (raised by WS-A, 2026-10-15)
- [WS-F] replace `prepare-mac-automation.ts` `replaceAll` branding with `OBU_BRAND_FILE=<per-channel json>` + `scripts/package-chrome-extension-brand.mjs` (`manifestKey` pins the id) (raised by WS-A, 2026-10-15)
- [WS-D] a WS-D test fixture was observed listening on WS-A's ports 47210/47211 (`obu-snap-*` profile); use your own 47240/47241 (raised by WS-A, 2026-10-15)
