# Run the obu-agent stack on your real Chrome (macOS)

This installs the whole production path — Reason Agent extension → Go native
host relay → resident `obu-agent` daemon — into your everyday Google Chrome,
**side by side** with any existing Open Browser Use or Reason Browser Use
install. Nothing existing is overwritten.

| Piece | Where | Collides with existing installs? |
|---|---|---|
| Extension "Reason Agent" (unpacked) | `~/Library/Application Support/Reason Agent Browser/extension` | No: own name and id (`reason-agent` brand) |
| Native host name | `com.reasonmachines.browser_agent.extension` | No: existing hosts are `com.ifuryst.open_browser_use.extension`, `com.reasonmachines.browser_use.extension` |
| Native host manifest | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.reasonmachines.browser_agent.extension.json` | New file; the script refuses to replace a different one without `--force` |
| Relay socket + `active.json` + `relay.token` | `/tmp/reason-agent-browser-use/` | No: existing hosts use `/tmp/open-browser-use`, `/tmp/reason-browser-use` |
| Daemon state (socket, token, SQLite, artifacts) | `~/Library/Application Support/Reason Agent Browser/browser/<profile>/` | No |
| Host + daemon binaries | `~/Library/Application Support/Reason Agent Browser/{bin,obu-agent}` | No |

## Install

Requirements: Node ≥ 22, Go, pnpm (all already on this Mac). From a checkout of
`reason-machines/open-browser-use`:

```sh
scripts/install-local-agent.sh --dry-run   # prints every command and file it would write
scripts/install-local-agent.sh             # builds and installs
```

Then the one manual step. Stable Chrome (≥ 137) ignores `--load-extension`, so
an unpacked extension can only be added from the UI:

1. Open `chrome://extensions` in the Chrome profile agents should use.
2. Turn on **Developer mode** (top right).
3. **Load unpacked** → `~/Library/Application Support/Reason Agent Browser/extension`.
   The card reads **Reason Agent**; its ID is printed by the script. The ID is
   derived from that path, so it stays the same across re-installs.
4. Leave **Allow access to file URLs** off. Uploads don't need it.

Chrome starts the native host on its own; the host starts the daemon and
restarts it if it crashes. Check:

```sh
cat /tmp/reason-agent-browser-use/active.json   # profile + agentSocket appear within a few seconds
```

## Use it from an agent

Every agent (and every subagent) gets its own session, with its own tabs in one
grey **Reason** tab group:

```sh
"$HOME/Library/Application Support/Reason Agent Browser/bin/reason-browser-agent-mcp" \
  --session <run-id> [--parent <parent-run-id>] [--label <name>]
```

This is an MCP stdio server exposing `browser_tabs_*`, `browser_snapshot`,
`browser_act`, `browser_navigate`, `browser_screenshot`, `browser_wait`,
`browser_evaluate`, `browser_cdp`, `browser_repl` and `browser_finish`. For
example, for Codex:

```sh
codex exec -c mcp_servers.browser.command="$HOME/Library/Application Support/Reason Agent Browser/bin/reason-browser-agent-mcp" \
  -c 'mcp_servers.browser.args=["--session","run-123"]' "…task…"
```

Scripts can call the daemon directly: `node …/obu-agent/dist/daemon/main.js call daemon.info '{}' --socket <agentSocket> --profile <profile>`.

## What you will see

- Agent tabs open in the background in a grey group titled **Reason**. Your
  active tab and the frontmost app are not changed.
- Chrome's own `"Reason Agent" started debugging this browser` bar appears while
  a tab is attached. Extensions can't hide it on stock Chrome. Tabs detach after
  30 s idle and at session end, and the bar goes away once nothing is attached.
- Tabs are closed when the agent finishes (`browser_finish` / `session.close`),
  when its lease lapses (60 s without a call), or 10 s after a daemon restart if
  nobody reconnects. A tab you drag out of the group is yours: the agent loses it.

## Known limits on stock Chrome

- A page's own `window.open()` popup opens in the foreground. The extension
  gives your tab back, but macOS may bring Chrome to the front (BACKLOG).
- After the agent types or clicks in a background tab, `document.hasFocus()`
  stays true on that page until it navigates (BACKLOG).

## Uninstall

```sh
scripts/install-local-agent.sh --uninstall
```

Then remove **Reason Agent** in `chrome://extensions`.

## How this was verified

`scripts/install-local-agent.sh --prefix <tmp> --chrome-hosts <cft-profile>/NativeMessagingHosts --socket-dir <tmp>`
installed into a throwaway Chrome for Testing profile. Chrome started the host,
the host started the daemon, and `reason-browser-agent-mcp` listed all 14 tools
and opened and snapshotted a tab. That run caught two bugs, both fixed:

- the daemon never started from a path containing spaces
- the extension ID was computed from a path with an unresolved `/tmp` symlink

Never run against your real Chrome without your go-ahead.
