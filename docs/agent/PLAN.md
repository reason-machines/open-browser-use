# Agent-browser build: fork rules

Repo: `reason-machines/open-browser-use` (fork of `iFurySt/open-browser-use` v1.1.0).
Goal: a resident `obu-agent` daemon + hardened extension/host that make the
user's real Chrome on macOS the fastest, most reliable agent browser:
one active tab per agent, isolated subagent tabs, aria snapshots with stable
refs, CDP-native input, event-driven settle, no focus theft.

Read before coding: `ARCHITECTURE.md`, `contract.md`, `WORKSTREAMS.md` (your
stream), `BASELINE.md` (numbers to beat).

## Rules every stream follows

1. **Own your paths.** Change files you own freely. Outside them, only the
   exact small edits listed under "may touch" for your stream. Anything else
   goes in `BACKLOG.md` as a line for the owner.
2. **Contract first.** Code against `packages/obu-agent/src/contract.ts` and
   `src/seams.ts`. If you must change them, update `contract.md` in the same
   commit and note it in your report + `BACKLOG.md`.
3. **Durable clones, pushed branches.** Work in
   `~/Code/open-browser-use-forks/r<N>-<stream>` (a `git clone` of the fork),
   branch `r<N>-<stream>`, and `git push origin HEAD:refs/heads/r<N>-<stream>`
   after **every** commit.
4. **Ports.** Fixture server ports per stream (check `lsof -i :<port>` first):
   A 47210/47211, B 47220/47221, C 47230/47231, D 47240/47241,
   E 47250/47251, F 47260/47261, G 47270/47271. Daemon test sockets go under
   `$TMPDIR/obu-<stream>/`.
5. **Processes.** Stop only PIDs you started. Never `pkill` by name. Never
   install or upgrade system packages (no Homebrew).
6. **The user's browser.** Live checks may open tabs in the user's Chrome only
   through a session you own; never touch, focus or close the user's own tabs;
   close everything you open (`finalizeTabs`/`session.close`). Prefer Chrome
   for Testing with a temp profile for destructive or noisy tests.
7. **Clean room.** Never copy code from Aside bundles (proprietary). Their
   behaviour is a spec only. Playwright (Apache-2.0) code may be adapted with
   attribution.
8. **No secrets** in code, logs, fixtures or docs.
9. **History.** Add a `docs/histories/YYYY-MM/` entry for your stream (repo rule).

## Definition of done (every stream)

Separate commands, each exit code checked (`set -o pipefail` if piping):

```sh
pnpm install --frozen-lockfile || pnpm install
pnpm --filter obu-agent build
pnpm --filter obu-agent typecheck
pnpm --filter obu-agent test
go build ./... && go test ./...
```

…plus your stream's acceptance commands in `WORKSTREAMS.md` and one **live
check** against real Chrome. Report: commits, what works, how verified (with
numbers), departures from the contract, what remains.
