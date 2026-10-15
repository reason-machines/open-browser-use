# Agent daemon contract and scaffold (round 0)

## Request

Make Open Browser Use a best-in-class agent browser on the user's local Mac
Chrome (per-agent tabs, subagent isolation, fast snapshots and actions),
informed by a study of how a commercial agentic browser does it. Round 0:
shared contract, scaffold, baseline.

## Changes

- `docs/agent/`: fork rules (PLAN), architecture decisions, the obu-agent
  JSON-RPC contract + behaviour spec, round-1 workstreams, backlog, baseline.
- `packages/obu-agent/`: new TypeScript package — typed contract
  (`src/contract.ts`), internal seams, injected-world API types, error
  envelope, `[system]` event rendering, NDJSON JSON-RPC server/client,
  per-tab keyed mutex, module stubs per stream, fixture-site skeleton, tests.
- `bench/baseline.mjs` + `bench/baseline.json`: latency of today's path.

## Why

Measured latency shows the relay hop is sub-millisecond; seconds per agent
step come from process spawn, polling, attach-per-call and the lack of
agent-level actions. A resident daemon with a fixed contract lets the
extension, host, daemon, snapshot, action and product streams build in
parallel without colliding.
