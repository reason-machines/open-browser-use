#!/usr/bin/env bash
# Usage: bench/run.sh --agent aside|ours|both --suite hard|mind2web|all [--tasks id,...] [--stack obu|obu-agent] [--run ID]
set -euo pipefail
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/runner.py" "$@"
