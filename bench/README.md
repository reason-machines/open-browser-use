# Agent benchmark: Aside vs ours

Runs the same browsing tasks with Aside's agent and with our agent, using the same model on both, and grades the answers with a separate judge.

```sh
bench/run.sh --agent aside|ours|both --suite hard|mind2web|all [--tasks id,...] [--stack obu|obu-agent] [--run ID] [--rejudge] [--skip-existing]
```

| | Aside | Ours |
|---|---|---|
| Driver | `aside -m aside/gpt-6-luna --effort medium --log-dump …` (Aside's built-in agent, REPL and guide) | `codex exec -m gpt-6-luna --ignore-user-config -s read-only` with only one MCP server, `obu` |
| Browser | Aside.app (its own Chromium) | Real Google Chrome, profile `Profile 2` ("QA Runner", no personal logins), override with `BENCH_CHROME_PROFILE` |
| Stack switch | — | `--stack obu` (today's `obu mcp`) or `--stack obu-agent` (new daemon, `OBU_AGENT_BIN … mcp --attach`) |
| Cleanup | every created session is archived; ids are logged to `~/.local/state/obu-bench/.aside-sessions-created` | `obu finalize-tabs --keep []` for each task session |

**Judge.** `codex exec -m gpt-6.1-sol` with a JSON schema (`success`, `score`, `reason`, `failure_category`). It reads the task, the answer key (hard suite) or the WebJudge key points (Mind2Web), the final answer and the last 80 trajectory entries.

**Prompts.** Both agents get the same task text plus the same read-only suffix. Ours also gets a short OBU tool primer, which stands in for the guide Aside builds into its agent.

## Suites

- **`tasks/hard.json`** has 25 tasks.
  - **12 local fixtures**, served by `fixtures/serve.py` on port 18731 (`BENCH_FIXTURE_PORT`):
    - shadow DOM
    - cross-site iframe (OOPIF)
    - infinite scroll
    - custom date picker
    - blob download read
    - popup window
    - pointer drag sort
    - range, switch and chips widgets
    - consent overlay and delayed enable
    - confirm, prompt and alert
    - hover mega-menu
    - file upload

    Answer keys are in `fixtures/answer-keys.json`, derived with `common.js:benchCode`.
  - **13 live, read-only tasks**: HN, PyPI, arXiv with the PDF table, books.toscrape, quotes scroll, GitHub, the jQuery UI datepicker in an iframe, the-internet gauntlet, RFC 9110, Wikipedia multi-hop and table, and a multi-tab stars ranking. Every answer key was checked against the APIs on 2026-10-15.
- **`tasks/mind2web.json`** has 20 Online-Mind2Web tasks. They are filtered to read-only and undated tasks and stratified by how many of the 6 reference agents succeeded: 8 hard, 6 medium, 6 easy. The source is the task list and key points in OSU-NLP-Group/Online-Mind2Web `data/evaluation_results`, because the HF dataset is gated. The original `website` field is therefore missing, so the agent has to find the site.

## Results

`results/<run>/<agent>/<task>/meta.json` and `judge.json` are committed, along with `results/<run>/summary.{md,json}`. Raw transcripts and trajectories stay local and are gitignored, because they contain third-party prompts and page dumps.

Re-grade a run without re-running the agents:

```sh
bench/run.sh --run <id> --suite all --rejudge
```
