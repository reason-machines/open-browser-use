#!/usr/bin/env bash
# Launch the new stack (Reason Agent extension -> Go host relay -> obu-agent daemon) on a throwaway
# Chrome for Testing profile for the `ours-new` bench arm. Fixture/public tasks only: no user logins.
# Prereq: scripts/install-local-agent.sh --prefix /tmp/obn/inst --chrome-hosts /tmp/obn/profile/NativeMessagingHosts --socket-dir /tmp/obn/relay
# Usage: bench/cft-new-stack.sh start|stop|status
set -euo pipefail
ROOT=/tmp/obn; PORT=${BENCH_CFT_PORT:-9471}
CFT="${E2E_CHROME:-$HOME/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing}"
case "${1:-status}" in
start)
  if [ -f $ROOT/cft.pid ] && kill -0 "$(cat $ROOT/cft.pid)" 2>/dev/null; then echo "already running"; exit 0; fi
  lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null && { echo "port $PORT busy"; exit 1; }
  mkdir -p $ROOT/profile/Default $ROOT/downloads
  [ -f $ROOT/profile/Default/Preferences ] || printf '{"download":{"default_directory":"%s","prompt_for_download":false,"directory_upgrade":true},"savefile":{"default_directory":"%s"}}' $ROOT/downloads $ROOT/downloads > $ROOT/profile/Default/Preferences
  "$CFT" --user-data-dir=$ROOT/profile --remote-debugging-port=$PORT \
    --load-extension=$ROOT/inst/extension --disable-extensions-except=$ROOT/inst/extension \
    --no-first-run --no-default-browser-check --password-store=basic --use-mock-keychain \
    --headless=new --window-size=1440,900 about:blank >$ROOT/cft.log 2>&1 &
  echo $! > $ROOT/cft.pid
  for i in $(seq 1 100); do [ -f $ROOT/relay/active.json ] && grep -q agentSocket $ROOT/relay/active.json && break; sleep 0.2; done
  cat $ROOT/relay/active.json; echo ;;
stop) [ -f $ROOT/cft.pid ] && kill "$(cat $ROOT/cft.pid)" 2>/dev/null; rm -f $ROOT/cft.pid; echo stopped ;;
status) [ -f $ROOT/cft.pid ] && kill -0 "$(cat $ROOT/cft.pid)" 2>/dev/null && echo running || echo stopped; cat $ROOT/relay/active.json 2>/dev/null ;;
esac
