# obu-agent

Resident daemon that turns Open Browser Use into an agent browser: per-agent
sessions and tab leases, CDP session management, aria snapshots with stable
refs, actions with actionability + settle waiting, screenshots, uploads and
downloads. Contract: `src/contract.ts` and `docs/agent/contract.md`.

```sh
pnpm --filter obu-agent build
pnpm --filter obu-agent test
node packages/obu-agent/dist/daemon/main.js --profile Default --socket /tmp/obu-agent.sock
node packages/obu-agent/fixtures/server.mjs   # fixture site on :47110 / :47111
```
