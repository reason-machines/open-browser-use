# Extension wire v2 (host/daemon ⇄ extension)

JSON-RPC 2.0 over Chrome native messaging. Every request carries
`session_id` + `turn_id` (the browser session), optionally `parent_session_id`
(subagent), `label`, and `route{profileId}`. `getInfo().capabilities.wire`
lists the features below; a daemon must feature-detect, not version-sniff.

## Requests (new or changed)

| Method | Params | Result |
|---|---|---|
| `getInfo` | — | `metadata.profileId` (= `extensionInstanceId`, per Chrome profile), `metadata.brand`, `capabilities.wire[]` |
| `createTab` | `url?` (opened directly, no extra navigate) | `{id, url, title, active:true, targetId?}` — background tab in the session's bound window, never focused |
| `executeCdp` | `target{tabId, sessionId?}`, `method`, `commandParams`, `timeoutMs?` | CDP result. **Implicit attach** (no `attach` call needed). `target.sessionId` = flat child session (OOPIF/worker) from `Target.attachedToTarget` |
| `getTargetId` | `tabId` | `{tabId, targetId}` |
| `subscribe` | `tabId`, `domains[]` (`"*"` = all) | `{tabId, domains}` |
| `unsubscribe` | `tabId?` (omit = all for the session) | — |
| `closeTab` | `tabId` | `{closed, released, reason?}` — close guard (below) |
| `finalizeTabs` | `keep[{tabId, status:'handoff'\|'deliverable'}]` | `{closedTabIds, releasedTabIds, keptTabIds, guardedTabs[{tabId, reason}]}` |
| `configure` | `idleDetachMs?` (0 = never), `sessionLeaseMs?` (0 = off) | current values |

Unchanged: `attach` (now idempotent, returns `{tabId, alreadyAttached}`),
`detach`, `getTabs`, `getUserTabs`, `claimUserTab`, `nameSession`, history,
clipboard, file chooser, downloads, WebMCP, cursor.

## Notifications (extension → host)

| Method | Params | When |
|---|---|---|
| `onCDPEvent` | `{source, method, params, sessionId?, subscribers?}` | CDP event. `sessionId` = child session. `subscribers` lists the session ids subscribed to it; absent = legacy broadcast (nobody subscribed to that tab) |
| `debuggerAttached` | `{tabId}` | a fresh `chrome.debugger` attachment: CDP state is empty, re-run the attach sequence |
| `debuggerDetached` | `{tabId, reason}` | `idle` (our idle detach), `canceled_by_user` (infobar Cancel), `target_closed`, … |
| `leaseRevoked` | `{tabId, sessionId, reason:'group_exit', groupId}` | the user dragged an owned tab out of the agent group / to another window; ownership is gone |
| `tabClosed` | `{tabId, sessionId}` | an owned tab was closed by someone other than us |
| `popupOpened` | `{tabId, openerTabId, sessionId, url?}` | a tab opened by a session tab was adopted into that session |
| `sessionExpired` | `{sessionId, closedTabIds, …}` | extension lease backstop finalized an idle session |
| `onDownloadChange` | `{id, filename, url, status, referrer?, startTime?, mime?, totalBytes?, tabId?, tabConfidence?, guid?, sessionId?}` | `tabConfidence`: `cdp` (matched `Page.downloadWillBegin`), `referrer`, `only_active` |
| `heartbeat` | `{at}` | every 30 s |

Always forwarded for a tab even when its subscriptions exclude the domain:
dialogs (`Page.javascriptDialogOpening/Closed`), `Page.fileChooserOpened`,
download begin/progress, `Target.attachedToTarget/detachedFromTarget/targetCrashed`,
`Inspector.detached/targetCrashed`. The extension never answers dialogs; the
daemon decides.

## Errors

`error.code` / `error.data.code`: `-32010 profile_mismatch` (route mismatch),
`-32011 tab_not_owned`. Everything else is `-32000` with the message.

## Framing

Chrome caps host→extension messages at 1 MB. The host splits any larger JSON
text into `{chunk:{id, i, n, data}}` frames (`data` = i-th slice of the JSON
string, each frame < 1 MB); the extension reassembles in any order and drops
partials after 30 s. Extension→host messages are not chunked (Chrome allows
up to 64 MiB); 5 MB results are verified live.

## Tabs, groups, ownership

- One Chrome tab group per **root** session, created on first tab; subagents
  (`parent_session_id`) put tabs in the root's group but own them
  individually — `getTabs` and `executeCdp` only see the caller's own tabs.
- Group title is the brand mark only (`BRAND.groupTitle`, e.g. `Reason`), one
  colour (`BRAND.groupColor`); no task label, checkmark or status. Session
  labels are stored for diagnostics only.
- New tabs: `tabs.create({active:false})` into the session's bound window
  (last-focused normal → only normal → focused), never activating a tab or
  focusing a window.
- Close guard: an owned tab is closed only if it is still in the agent group
  and is not the active tab of a non-minimized window; otherwise it is
  ungrouped and released to the user (`guardedTabs`). Agent popup windows are
  always closable.
- Popups: attributed to the opener's session, else to the agent group Chrome
  placed the tab in (plus the most recent acting session within 2 s). If the
  popup came up in the foreground, the user's previously active tab is
  re-activated.
- Lease backstop: sessions with no request for `sessionLeaseMs` (default
  5 min) are finalized by the extension (agent tabs closed, handoff tabs kept).

## Debugger infobar

Chrome shows `"<extension name>" started debugging this browser` while any tab
is attached through `chrome.debugger`. It cannot be hidden from an extension
on stock Chrome (only the `--silent-debugger-extension-api` command-line
switch suppresses it). We minimise it: tabs are attached lazily on the first
CDP call, detached after `idleDetachMs` (default 30 s) without CDP traffic, and
detached at turn end/finalize. The banner disappears once no tab is attached.

## Branding

`background.js` holds an `@obu-brand-begin … @obu-brand-end` block generated
from `brands/<id>.json` by `scripts/package-chrome-extension-brand.mjs`
(`OBU_BRAND=<id>` or `OBU_BRAND_FILE=<json>` for packaging). Fields:
`id, displayName, description?, nativeHostName, groupTitle, groupColor,
deliverableGroupTitle, deliverableGroupColor, manifestKey?`.

## Live check

`node apps/chrome-extension/live/run-live.mjs [--brand reason] [--screenshot out.png]`
runs Chrome for Testing with a throwaway profile, the staged extension and a
test native host, then quits Chrome and deletes the profile. Stable Chrome
(≥ 137) ignores `--load-extension`, so live checks use Chrome for Testing.
