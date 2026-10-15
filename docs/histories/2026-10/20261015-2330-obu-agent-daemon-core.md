## [2026-10-15 23:30] | Task: WS-C obu-agent daemon core

### 🤖 Execution Context

- **Agent ID**: `r1-daemon (fork of the round-1 orchestrator)`
- **Base Model**: `claude-opus-5-5`
- **Runtime**: `Claude Code CLI, macOS arm64, Node 26`

### 📥 User Query

> Make our Open Browser Use stack the fastest, most reliable agent browser on the user's Mac: every (sub)agent gets its own tabs, one active tab at a time.

### 🛠 Changes Overview

**Scope:** `packages/obu-agent`

**Key Actions:**

- **Daemon core**: resident `obu-agent` with token-authenticated unix socket, pid lock per profile, `node:sqlite` state (JSON fallback), full JSON-RPC handler table (sessions, tabs, snapshot/act/navigate/screenshot/evaluate/cdp/wait).
- **Sessions & leases**: parent/child sessions, owned/borrowed tabs, `tabs.transfer`, one active tab per session, 60 s leases with a 1 s sweeper, reconcile on start, per-tab mutex.
- **CDP runtime**: attach sequence without `Runtime.enable`, owned-tab 1440x900 override + lifecycle active, flat OOPIF child sessions, injected bundle in the `__obu_utility` isolated world with health check/re-inject, focus emulation only during act/navigate/snapshot, dialog policy.
- **Backends**: native-host relay (WS-B auth frame, env/registry resolution, reconnect) and direct `--remote-debugging-port` (tests / fast mode).
- **MCP**: `obu-agent mcp --attach` stdio proxy with 13 static tool schemas; `obu-agent call`.
- **Tests**: 17 unit tests (fake clock, fake backend, fake relay) + 13 live checks on Chrome for Testing (`pnpm --filter obu-agent test:live`).

### 🧠 Design Intent (Why)

Ownership truth and all page logic move into one resident process so each agent step is one socket round trip, subagents can never act on each other's tabs, and crashed agents never leave tabs behind.

### 📁 Files Modified

- `packages/obu-agent/src/{daemon,session,lease,store,cdp,server,mcp}/**`, `src/index.ts`, `package.json`
- `packages/obu-agent/test/daemon-*.{test.mjs,mjs}`
- `docs/agent/contract.md`, `docs/agent/BACKLOG.md`
