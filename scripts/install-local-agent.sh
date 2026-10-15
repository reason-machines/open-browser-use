#!/usr/bin/env bash
# Install the obu-agent stack (Reason Agent extension + Go native host + resident
# obu-agent daemon) into the user's REAL Google Chrome on this Mac, SIDE BY SIDE
# with any existing Open Browser Use / Reason Browser Use install:
#   - its own native-host name   com.reasonmachines.browser_agent.extension
#   - its own relay socket dir   /tmp/reason-agent-browser-use
#   - its own state dir          ~/Library/Application Support/Reason Agent Browser
# Nothing existing is overwritten; a different manifest under our host name is
# refused unless --force. Docs: docs/agent/INSTALL-LOCAL.md.
#
#   scripts/install-local-agent.sh [--dry-run] [--force] [--prefix DIR] [--uninstall]
#                                  [--chrome-hosts DIR] [--socket-dir DIR]   (testing: CfT profile)
set -euo pipefail

DRY_RUN=0
FORCE=0
UNINSTALL=0
CHROME_HOSTS_OVERRIDE=""
SOCKET_DIR_OVERRIDE=""
PREFIX="$HOME/Library/Application Support/Reason Agent Browser"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --prefix) PREFIX="$2"; shift ;;
    --chrome-hosts) CHROME_HOSTS_OVERRIDE="$2"; shift ;;
    --socket-dir) SOCKET_DIR_OVERRIDE="$2"; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BRAND=reason-agent
HOST_NAME=com.reasonmachines.browser_agent.extension
SOCKET_DIR="${SOCKET_DIR_OVERRIDE:-/tmp/reason-agent-browser-use}"
BRAND_DIR="Reason Agent Browser" # OBU_BRAND_DIR: daemon state under ~/Library/Application Support/<this>/browser/<profile>
CHROME_HOSTS="${CHROME_HOSTS_OVERRIDE:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
MANIFEST="$CHROME_HOSTS/$HOST_NAME.json"
EXT_DIR="$PREFIX/extension"
BIN_DIR="$PREFIX/bin"
AGENT_DIR="$PREFIX/obu-agent"
WRAPPER="$BIN_DIR/native-host.sh"
MCP_WRAPPER="$BIN_DIR/reason-browser-agent-mcp"

run() {
  if [ "$DRY_RUN" = 1 ]; then printf '[dry-run] %s\n' "$*"; else "$@"; fi
}
write_file() { # path mode <<content
  local path="$1" mode="$2" content
  content="$(cat)"
  if [ "$DRY_RUN" = 1 ]; then
    printf '[dry-run] write %s (mode %s):\n%s\n' "$path" "$mode" "$content" | sed 's/^/    /'
  else
    printf '%s\n' "$content" > "$path"
    chmod "$mode" "$path"
  fi
}

if [ "$UNINSTALL" = 1 ]; then
  if [ -f "$MANIFEST" ] && grep -q "$WRAPPER" "$MANIFEST"; then run rm -f "$MANIFEST"; fi
  run rm -rf "$PREFIX"
  echo "Removed. Also remove the \"Reason Agent\" extension in chrome://extensions."
  exit 0
fi

command -v node >/dev/null || { echo "node (>= 22) is required" >&2; exit 1; }
command -v go >/dev/null || { echo "go is required to build the native host" >&2; exit 1; }
command -v pnpm >/dev/null || { echo "pnpm is required" >&2; exit 1; }
NODE_BIN="$(command -v node)"

# Refuse to clobber a manifest we did not write.
if [ -f "$MANIFEST" ] && ! grep -q "$WRAPPER" "$MANIFEST" && [ "$FORCE" != 1 ]; then
  echo "refusing: $MANIFEST exists and points elsewhere (use --force to replace it)" >&2
  exit 1
fi
for other in com.ifuryst.open_browser_use.extension com.reasonmachines.browser_use.extension; do
  [ -f "$CHROME_HOSTS/$other.json" ] && echo "note: existing host $other is left untouched"
done

echo "== build"
run pnpm --dir "$REPO" install --frozen-lockfile
run pnpm --dir "$REPO" --filter obu-agent build

echo "== install into $PREFIX"
run mkdir -p "$BIN_DIR" "$CHROME_HOSTS"
run rm -rf "$EXT_DIR" "$AGENT_DIR"
# Branded unpacked extension (stable path => stable extension id).
run node --input-type=module -e "import('$REPO/scripts/package-chrome-extension-brand.mjs').then((m) => m.stageBrandedExtension({ out: process.argv[1], brand: m.loadBrand({ brand: '$BRAND' }) }))" "$EXT_DIR"
# Native host relay + obu-agent supervisor.
run go build -C "$REPO" -o "$BIN_DIR/obu-host" ./cmd/open-browser-use
# Self-contained daemon (dist + production node_modules).
run pnpm --dir "$REPO" --filter obu-agent deploy --prod "$AGENT_DIR"

# Chrome's id for an unpacked extension: sha256(absolute path) mapped to a..p.
EXT_ID="$(node -e '
const { createHash } = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
// Chrome hashes the canonical path (symlinks resolved, e.g. /tmp -> /private/tmp).
const dir = fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : path.resolve(process.argv[1]);
const hex = createHash("sha256").update(dir).digest("hex").slice(0, 32);
console.log([...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join(""));
' "$EXT_DIR")"

write_file "$WRAPPER" 755 <<EOF
#!/bin/sh
# Reason Agent native host: relay on $SOCKET_DIR + supervised obu-agent daemon.
export OBU_BRAND=$BRAND OBU_BRAND_DIR="$BRAND_DIR"
export OBU_AGENT_BIN="$AGENT_DIR/dist/daemon/main.js" OBU_NODE="$NODE_BIN"
exec "$BIN_DIR/obu-host" host --socket-dir "$SOCKET_DIR" 2>>"$PREFIX/native-host.log"
EOF

write_file "$MCP_WRAPPER" 755 <<EOF
#!/bin/sh
# MCP stdio server for one agent session on the user's Chrome. Usage:
#   reason-browser-agent-mcp [--session ID] [--parent PARENT_ID] [--label L]
# Finds the live daemon socket from the host's registry (one per Chrome profile).
REG="\$("$NODE_BIN" -e 'try { const r = JSON.parse(require("fs").readFileSync("$SOCKET_DIR/active.json", "utf8")); if (r.agentSocket && r.profile) console.log(r.agentSocket + "\\n" + r.profile); } catch {}')"
SOCK="\$(printf '%s\n' "\$REG" | sed -n 1p)"; PROFILE="\$(printf '%s\n' "\$REG" | sed -n 2p)"
[ -n "\$SOCK" ] || { echo "Reason Agent daemon not running: open Chrome with the Reason Agent extension enabled" >&2; exit 1; }
export OBU_BRAND_DIR="$BRAND_DIR"
exec "$NODE_BIN" "$AGENT_DIR/dist/daemon/main.js" mcp --attach --no-spawn --socket "\$SOCK" --profile "\$PROFILE" "\$@"
EOF

write_file "$MANIFEST" 644 <<EOF
{
  "name": "$HOST_NAME",
  "description": "Reason Agent native host (obu-agent)",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

cat <<EOF

== one manual step (stable Chrome ignores --load-extension)
1. Open chrome://extensions in the Chrome profile agents should use.
2. Turn on "Developer mode" (top right).
3. "Load unpacked" -> select:
     $EXT_DIR
   The card must read "Reason Agent", ID $EXT_ID.
   Leave "Allow access to file URLs" OFF (uploads do not need it).
Chrome then starts the host, which starts the daemon. Check with:
     cat $SOCKET_DIR/active.json        # profile + agentSocket
Agents connect with:
     "$MCP_WRAPPER" --session <run-id> [--parent <parent-run-id>]
Uninstall: $0 --uninstall
EOF
