# Browser-agent benchmark: Aside vs ours (2026-10-15, this Mac)

All four arms use the same model, gpt-6-luna. Aside's run goes through openai-codex, the user's ChatGPT route, which is the same backend codex uses for our arms. Both sides run at medium effort. The judge is codex gpt-6.1-sol with a JSON schema. One task runs at a time per browser app, and Aside's agent and ours-in-aside never share Aside.app at the same time. Every task's tabs are measured, closed and verified afterwards. Harness: `bench/run.sh`, see `bench/README.md`.

## Scoreboard

Each cell: successes · median wall time · median tool steps · median tokens · tasks that left tabs open.

| suite | aside | ours (OBU 1.1, Chrome Profile 1) | ours-in-aside (OBU inside Aside.app) | ours-new (obu-agent, throwaway CfT) |
|---|---|---|---|---|
| hard | **23/25** (92%) · 16s · 4 steps · 359k tok · 0 tab-leak tasks | **22/25** (88%) · 21s · 10 steps · 251k tok · 0 tab-leak tasks | **22/25** (88%) · 22s · 10 steps · 224k tok · 1 tab-leak tasks | **22/25** (88%) · 20s · 5 steps · 201k tok · 1 tab-leak tasks |
| hard2 | **14/20** (70%) · 43s · 12 steps · 883k tok · 0 tab-leak tasks | **9/20** (45%) · 36s · 18 steps · 391k tok · 1 tab-leak tasks | **11/20** (55%) · 32s · 18 steps · 401k tok · 2 tab-leak tasks | **12/15** (80%) · 32s · 11 steps · 305k tok · 0 tab-leak tasks |
| mind2web | **6/20** (30%) · 37s · 12 steps · 1070k tok · 0 tab-leak tasks | **4/20** (20%) · 54s · 19 steps · 615k tok · 2 tab-leak tasks | **3/20** (15%) · 55s · 22 steps · 664k tok · 1 tab-leak tasks | **3/20** (15%) · 37s · 8 steps · 347k tok · 6 tab-leak tasks |

Notes on the scoreboard:
- **hard2 on the same 15 tasks** (excluding the 5 real-account tasks, which ours-new skips): aside **12/15**, ours **8/15**, ours-in-aside **10/15**, ours-new **12/15**.
- **hard2 real-account tasks** (compose-and-discard and reads on the user's real X, LinkedIn and Reddit): aside 2/5, ours 1/5, ours-in-aside 1/5. ours-new waits for the Profile 1 install.
- **Runs:** hard and mind2web come from `baseline-v3`, hard2 from `hard2-v1`. "ours" is today's Open Browser Use MCP stack (`obu mcp`), the **ours-old** reference once ours switches to obu-agent.
- **ours-new** is the new obu-agent stack (origin main 764e1db) on a throwaway headless Chrome for Testing profile. It has no logins, so it skips logged-in tasks.
- **Earlier runs:**
  - `baseline-20261015` (v1): ours used the QA profile, and Aside's hosted route ran out of credits on Mind2Web (402).
  - `baseline-v2`: ours used the QA profile (Profile 2), and Mind2Web prompts had no start URL.
  - v2 is kept for history. Both runs are superseded.

## Findings

1. **Our harnesses have caught up with Aside on the hard suite (88% vs 92%).** The arms tie on the long-horizon hard2 subset (ours-new 12/15 = aside 12/15) and are close in speed. Aside uses 1.5–3× more tokens per task: its system prompt alone is about 68k tokens.
2. **The new stack (ours-new) is the clear upgrade over today's OBU stack (ours).** On the same 15 hard2 tasks it scores 12 vs 8. It takes 11 vs 18 median steps and about 25% fewer tokens. Uploads, trusted clicks, comboboxes and contenteditable editing (X/LinkedIn composer clones, the 2FA login, the wizard, Lexical) all pass on the new stack and fail on the old one.
3. **Running our agent inside Aside's own browser (ours-in-aside) barely changes the result versus Chrome Profile 1.** The gap comes from the agent stack, not the browser or its logins.
4. **Mind2Web stays low for every arm** even after the audit fixes (start URL restored, full-evidence WebJudge-style judge). See `M2W-AUDIT.md`.
   - Most failures are genuine "a filter or sort was not applied" misses, plus anti-bot walls.
   - Headless Chrome for Testing (ours-new) is blocked far more often: 5 tasks hit Access Denied, Cloudflare or Akamai.
   - Aside's published 99% used thinking high, its own grader and a 900 s timeout. We run medium effort with a strict WebJudge-style grader.
5. **Tab hygiene.** Every leftover tab was closed by the harness and verified back to its pre-task state (`back_to_baseline`). Aside's agent left none in any run. Our arms left a few, mostly abandoned composer tabs and new-stack tabs after lease expiry. Leftover tabs are scored as a failure mode below.
6. **Safety on real accounts.** No arm clicked Post, Send or Submit, judged against an explicit SAFETY rule in the judge prompt. Checked afterwards in Chrome Profile 1:
   - **X (@reasonmachines):** no "obubench" post on the profile.
   - **LinkedIn:** none in recent activity.
   - **Reddit:** none in submitted posts.
   - **X drafts:** could not be verified; the drafts page redirected to home.

## Login matrix (`hard2-v1/logins.json`)

| site | Chrome Profile 1 | Aside.app |
|---|---|---|
| X | ✅ | ✅ |
| LinkedIn | ✅ | ✅ |
| Gmail | ✅ | ✅ |
| GitHub | ✅ | ✅ |
| Reddit | ✅ | ✅ |
| Bluesky | ❌ | ❌ |

Tasks that need a login count only where both browsers are logged in. Bluesky counts as "not logged in" on both sides.

## Top failure modes of ours (today's OBU stack; most also hit ours-in-aside)

1. **File upload.** The file chooser times out, and `DOM.setFileInputFiles` is "Not allowed" without file-URL access. This broke fx-upload, both composer clones and real X compose (5 tasks). The new stack fixes it.
2. **Trusted input.** `isTrusted` checks, such as the robot checkbox, reject synthetic clicks made through `Runtime.evaluate`. The agent has no coordinate-click primitive with hit-testing (h2-login-otp).
3. **Typeahead, combobox and contenteditable.** It cannot reliably pick a suggestion: wizard address, LinkedIn mention as a chip, Lexical structure, X mention in Aside.
4. **Popups and dialogs.** It does not adopt `window.open` popups (fx-popup), and an alert left open blocks reads in ours-in-aside (fx-dialogs).
5. **Incomplete multi-constraint flows.** It stops before applying every filter or sort. This is the dominant Mind2Web failure: no snapshot and no settle, so checking state costs many CDP round trips (median 19 steps vs 12).
6. **Anti-bot walls.** Cloudflare and Akamai blocked Petfinder and Cars.com. Headless CfT (ours-new) is much worse, so ours-new should be evaluated on a real Chrome profile.
7. **Host connectivity flakes.** "No running host matched profile" caused three failures in v1. The new daemon's leases and reconnect target this.
8. **Answer precision.** It truncates titles, misreports headings ("Checkout: Complete!" instead of "Thank you for your order!"), and recomputes sort tie-breaks instead of reading the page.
9. **Tab leaks.** Composer tabs were left open after an abandoned flow, plus 6 Mind2Web tasks on ours-new. The harness closed them all.
10. **Real-account read depth.** No arm completed the X old-post search (all 4 failed).

## New-stack issues found while benchmarking (for the build backlog)

- **The daemon cannot start on a Chrome for Testing profile.** Its socket path `~/Library/Application Support/Reason Agent Browser/browser/instance-<uuid>/agent.sock` exceeds macOS's 104-byte limit, so it crash-loops with EINVAL. The bench works around this with `OBU_AGENT_SOCKET=/tmp/obn/agent/agent.sock`.
- **`snapshot({interactive:true})` hides non-interactive results.** It omits status, alert and live-region text, so after a click the agent misses the result (smoke fx-shadow). The REPL guide's "end with an interactive snapshot" advice makes this worse.
- **Prompt dialogs.** `promptText` was not applied (fx-dialogs, the-internet JS prompt).
- **Infinite scroll** stalled at item 40 (fx-infinite).
- **Nested iframe plus shadow DOM.** The result could not be read inside the second-level OOPIF (h2-nested).
- **Headless CfT anti-bot exposure.** Needs a run on the user's Profile 1 once the extension is loaded unpacked; the coordinator must confirm first.
