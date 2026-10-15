#!/usr/bin/env python3
"""Head-to-head browser-agent benchmark: Aside's agent vs ours (codex + Open Browser Use).

Both agents run the same model (gpt-6-luna) on the same prompt. A separate judge
(codex, gpt-6.1-sol) grades each final answer against an answer key (hard suite)
or WebJudge-style key points (Online-Mind2Web subset).

stdlib only. See bench/README.md.
"""
import argparse, concurrent.futures as cf, json, os, re, shutil, signal, socket, statistics
import subprocess, sys, threading, time
from pathlib import Path

BENCH = Path(__file__).resolve().parent
STATE = Path.home() / ".local/state/obu-bench"
ASIDE_SESSIONS_LOG = STATE / ".aside-sessions-created"
UPLOAD_FILE = Path.home() / "Downloads/obu-bench/upload-me.txt"
FIXTURE_PORT = int(os.environ.get("BENCH_FIXTURE_PORT", "18731"))
AGENT_MODEL = os.environ.get("BENCH_AGENT_MODEL", "gpt-6-luna")
# openai-codex = the user's ChatGPT subscription route, the same backend codex uses for our agent.
# (The Aside-hosted route `aside/gpt-6-luna` ran out of credits mid-baseline: 402 Insufficient credits.)
ASIDE_MODEL = os.environ.get("BENCH_ASIDE_MODEL", f"openai-codex/{AGENT_MODEL}")
JUDGE_MODEL = os.environ.get("BENCH_JUDGE_MODEL", "gpt-6.1-sol")
CHROME_PROFILE = os.environ.get("BENCH_CHROME_PROFILE", "Profile 2")  # "QA Runner": no personal logins
REAL_PROFILE = os.environ.get("BENCH_REAL_PROFILE", "Profile 1")  # the user's real logged-in profile (tasks with "profile": "real")

SUFFIX = """

Safety rules: never complete a real purchase or payment, log in, sign up, post, send messages, or change account settings on a real public website. Using page controls is allowed and expected: search boxes, filters, sorting, date pickers, quizzes, selecting options, and any form, dialog, upload or download on the local test pages at 127.0.0.1 / localhost (those are offline test fixtures, so submitting them is fine). Work in your own new tab(s); do not touch tabs you did not open.
When you are done, end your reply with one line that starts with `FINAL ANSWER:` followed by the complete answer (include every requested value)."""

SAFETY_OVERRIDES = {
    "test_login": """

Safety rules: logging in with the TEST credentials given in the task is allowed on these public demo/test sites and on the local test pages at 127.0.0.1 / localhost. Never use any other credentials, never purchase or pay for real, never post or send anything on a real website. Interacting with page controls and submitting forms on the demo sites and local fixtures is allowed. Work in your own new tab(s); do not touch tabs you did not open. Close every tab you opened when you finish.
When you are done, end your reply with one line that starts with `FINAL ANSWER:` followed by the complete answer (include every requested value).""",
    "compose_discard": """

Safety rules (STRICT, real account): this browser is the user's REAL logged-in account. You may open the post composer, type text, add mentions/hashtags and attach the image, and you must verify the composer state. You must NEVER click Post / Tweet / Reply / Send / Publish / Share, and never press Cmd+Enter or Ctrl+Enter inside a composer. Do not like, follow, repost, message, or change any setting. When finished, close the composer and choose Discard/Delete so that no draft is saved and nothing is published. Work in your own new tab(s); do not touch tabs you did not open, and close the tabs you opened when you finish.
When you are done, end your reply with one line that starts with `FINAL ANSWER:` followed by the complete answer (include every requested value and explicitly state whether the draft was discarded).""",
    "real_read": """

Safety rules (STRICT, real account): this browser is the user's REAL logged-in account. Read only: never post, reply, like, follow, repost, message, vote, or change any setting, and do not open direct messages. Work in your own new tab(s); do not touch tabs you did not open, and close the tabs you opened when you finish.
When you are done, end your reply with one line that starts with `FINAL ANSWER:` followed by the complete answer (include every requested value).""",
}


def suffix_for(task):
    return SAFETY_OVERRIDES.get(task.get("safety"), SUFFIX)


# Guidance for our agent: plays the role of the guide Aside bakes into its own agent.
OURS_PREAMBLE = """You control a real Chrome browser through the `obu` MCP tools (Open Browser Use). The browser profile and session are already pinned for you.
- Start with `open_tab` (url) to get your own tab, then `wait_load`. Use the returned tab_id for later calls.
- Read pages with `page_info` (title, url, body text) or `cdp` with method `Runtime.evaluate` (params {"expression": "...", "returnByValue": true}) to query the DOM.
- Act with `cdp` Input.* events (Input.dispatchMouseEvent / Input.insertText / Input.dispatchKeyEvent) or DOM scripting via Runtime.evaluate. `Page.handleJavaScriptDialog` handles alert/confirm/prompt. `wait_file_chooser` + `set_file_chooser_files` handle uploads. `call` sends any raw Open Browser Use JSON-RPC method.
- Do not use shell commands to fetch web content; all web access goes through the browser tools. You may read local files (e.g. downloads in ~/Downloads) with shell.
- When finished call `finalize_tabs` with keep [].

Task:
"""

TERMINAL_LOCK = threading.Lock()


def log(msg):
    with TERMINAL_LOCK:
        print(time.strftime("%H:%M:%S"), msg, flush=True)


# ---------------------------------------------------------------- fixtures

def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def ensure_fixtures():
    if port_open(FIXTURE_PORT):
        return None
    proc = subprocess.Popen([sys.executable, str(BENCH / "fixtures/serve.py"), str(FIXTURE_PORT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if port_open(FIXTURE_PORT):
            return proc
        time.sleep(0.1)
    raise SystemExit("fixture server failed to start")


def ensure_upload_file():
    UPLOAD_FILE.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BENCH / "fixtures/upload-me.txt", UPLOAD_FILE)


def load_tasks(suite, only):
    tasks = json.loads((BENCH / "tasks" / f"{suite}.json").read_text())
    if only:
        want = set(only.split(","))
        tasks = [t for t in tasks if t["id"] in want]
    for t in tasks:
        t["prompt"] = (t["prompt"].replace("{FIXTURE}", f"http://127.0.0.1:{FIXTURE_PORT}")
                       .replace("{UPLOAD_FILE}", str(UPLOAD_FILE)))
    return tasks


# ---------------------------------------------------------------- helpers

def run_proc(cmd, out_path, err_path, timeout, cwd=None, env=None):
    """Run cmd with stdin closed; returns (exit_code|None on timeout, seconds)."""
    t0 = time.time()
    with open(out_path, "wb") as out, open(err_path, "wb") as err:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=out, stderr=err, cwd=cwd, env=env,
                             start_new_session=True)
        try:
            code = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
            code = None
    return code, time.time() - t0


def extract_final(text):
    if not text:
        return ""
    m = re.search(r"FINAL ANSWER:\s*(.*)", text, re.S | re.I)
    return (m.group(1) if m else text).strip()


def clip(s, n):
    s = s if isinstance(s, str) else json.dumps(s, ensure_ascii=False)
    return s if len(s) <= n else s[: n // 2] + f" …[{len(s) - n} chars]… " + s[-n // 2:]


# ---------------------------------------------------------------- Aside runner

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def run_aside(task, tdir):
    events = tdir / "events.ndjson"
    cmd = ["aside", "-m", ASIDE_MODEL, "--effort", "medium", "--log-dump", str(events), task["prompt"] + suffix_for(task)]
    code, secs = run_proc(cmd, tdir / "stdout.txt", tdir / "stderr.txt", task["timeout_s"])
    out = ANSI.sub("", (tdir / "stdout.txt").read_text(errors="replace"))
    err = ANSI.sub("", (tdir / "stderr.txt").read_text(errors="replace"))
    m = re.search(r"created new session: (\S+)", err + out)
    sid = m.group(1) if m else None
    if sid:
        STATE.mkdir(parents=True, exist_ok=True)
        with open(ASIDE_SESSIONS_LOG, "a") as f:
            f.write(sid + "\n")
        if code is None:
            subprocess.run(["aside", "session", "stop", sid], stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
        subprocess.run(["aside", "session", "archive", sid], stdin=subprocess.DEVNULL, capture_output=True, timeout=60)

    steps, tokens, final_text, traj, errors = 0, 0, "", [], []
    if events.exists():
        for line in events.read_text(errors="replace").splitlines():
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            ty, msg = e.get("type"), e.get("message") or {}
            if ty == "tool_execution_start":
                steps += 1
                traj.append(f"CALL {e.get('toolName')}: {clip(e.get('args'), 1200)}")
            elif ty == "tool_execution_end":
                res = e.get("result")
                traj.append(f"RESULT{' (error)' if e.get('isError') else ''}: {clip(res, 1500)}")
            elif ty == "message_end" and msg.get("role") == "assistant":
                tokens += (msg.get("usage") or {}).get("totalTokens", 0) or 0
                txt = "".join(c.get("text", "") for c in msg.get("content") or [] if c.get("type") == "text")
                if txt.strip():
                    final_text = txt
                    traj.append(f"ASSISTANT: {clip(txt, 1500)}")
                if msg.get("errorMessage"):
                    errors.append(msg["errorMessage"])
    if not final_text:
        final_text = out
    return {"exit": code, "timed_out": code is None, "seconds": round(secs, 1), "steps": steps,
            "tokens": tokens, "final": extract_final(final_text), "raw_final": final_text,
            "session_id": sid, "errors": errors[-3:]}, traj


# ---------------------------------------------------------------- our runner (adapter)

def profile_for(task):
    return REAL_PROFILE if task.get("profile") == "real" else CHROME_PROFILE


def mcp_server(stack, session_id, profile=None):
    """Adapter: which MCP server backs our agent. Swap stacks with --stack."""
    if stack == "obu":
        return "obu", ["mcp", "--profile", profile or CHROME_PROFILE, "--session-id", session_id, "--timeout", "60s"]
    if stack == "obu-agent":  # new daemon (packages/obu-agent); thin MCP proxy over the resident daemon
        return os.environ.get("OBU_AGENT_BIN", "obu-agent"), ["mcp", "--attach", "--profile", profile or CHROME_PROFILE,
                                                               "--session-id", session_id]
    raise SystemExit(f"unknown stack {stack}")


def finalize_obu(stack, session_id, profile=None):
    if stack == "obu":
        subprocess.run(["obu", "--profile", profile or CHROME_PROFILE, "finalize-tabs", "--session-id", session_id, "--keep", "[]"],
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=30)


def run_ours(task, tdir, stack, run_id):
    session_id = f"bench-{run_id}-{task['id']}"[:80]
    cmd_bin, cmd_args = mcp_server(stack, session_id, profile_for(task))
    work = tdir / "work"
    work.mkdir(exist_ok=True)
    cmd = ["codex", "exec", "--ignore-user-config", "--skip-git-repo-check", "--json", "-m", AGENT_MODEL,
           "-s", "read-only", "-C", str(work),
           "-c", 'web_search="disabled"',
           "-c", f"mcp_servers.obu.command={json.dumps(cmd_bin)}",
           "-c", f"mcp_servers.obu.args={json.dumps(cmd_args)}",
           "-c", "mcp_servers.obu.tool_timeout_sec=120",
           "-c", "mcp_servers.obu.startup_timeout_sec=30",
           "-c", 'mcp_servers.obu.default_tools_approval_mode="approve"',
           OURS_PREAMBLE + task["prompt"] + suffix_for(task)]
    code, secs = run_proc(cmd, tdir / "transcript.jsonl", tdir / "stderr.txt", task["timeout_s"])
    steps, tok, final_text, traj, errors = 0, 0, "", [], []
    for line in (tdir / "transcript.jsonl").read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        it = e.get("item") or {}
        if e.get("type") == "item.completed":
            ty = it.get("type")
            if ty == "mcp_tool_call":
                steps += 1
                res = it.get("result") or it.get("error")
                traj.append(f"CALL {it.get('tool')}: {clip(it.get('arguments'), 1200)}")
                traj.append(f"RESULT{' (error)' if it.get('status') != 'completed' else ''}: {clip(res, 1500)}")
            elif ty == "command_execution":
                steps += 1
                traj.append(f"SHELL {clip(it.get('command'), 600)} -> {clip(it.get('aggregated_output', ''), 800)}")
            elif ty == "agent_message":
                final_text = it.get("text", "")
                traj.append(f"ASSISTANT: {clip(final_text, 1500)}")
            elif ty == "error":
                errors.append(it.get("message"))
        elif e.get("type") == "turn.completed":
            u = e.get("usage") or {}
            tok += (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0)
        elif e.get("type") in ("turn.failed", "error"):
            errors.append(json.dumps(e)[:400])
    return {"exit": code, "timed_out": code is None, "seconds": round(secs, 1), "steps": steps, "tokens": tok,
            "final": extract_final(final_text), "raw_final": final_text, "session_id": session_id,
            "errors": errors[-3:]}, traj


# ---------------------------------------------------------------- tab hygiene
# The user's rule: every task must leave the browser with the tabs it found. We snapshot every tab
# (all windows, all profiles) of the app the agent drives before and after the task. Per-agent
# concurrency defaults to 1 so new tabs are attributable: Aside drives Aside.app, ours drives Chrome.

APP_FOR = {"aside": "Aside", "ours": "Google Chrome"}
TAB_SCRIPT = """tell application "%s"
set out to ""
repeat with w in windows
  repeat with t in (tabs of w)
    set out to out & ((id of t) as text) & "\t" & (URL of t) & linefeed
  end repeat
end repeat
return out
end tell"""


def tab_snapshot(app):
    try:
        r = subprocess.run(["osascript", "-e", TAB_SCRIPT % app], capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0:
        return None
    tabs = {}
    for line in r.stdout.splitlines():
        if "\t" in line:
            i, u = line.split("\t", 1)
            tabs[i.strip()] = u.strip()
    return tabs


def close_tabs(app, ids):
    for i in ids:
        subprocess.run(["osascript", "-e", f'tell application "{app}" to close (every tab of every window whose id is {int(i)})'],
                       capture_output=True, timeout=20)


HOST_RE = re.compile(r"https?://([A-Za-z0-9.-]+)")


def task_hosts(task, traj):
    hosts = set(HOST_RE.findall(task["prompt"] + "\n" + "\n".join(traj)))
    hosts |= {"127.0.0.1", "localhost"}
    base = set()
    for h in hosts:
        parts = h.lower().split(".")
        base.add(".".join(parts[-2:]) if len(parts) >= 2 else h.lower())
    return base


def attributable(url, hosts):
    if url in ("about:blank", "", "chrome://newtab/") or url.startswith(("chrome://newtab", "blob:", "data:")):
        return True
    m = HOST_RE.match(url)
    if not m:
        return False
    parts = m.group(1).lower().split(".")
    return (".".join(parts[-2:]) if len(parts) >= 2 else parts[0]) in hosts


def hygiene(agent, task, before, traj, harness_cleanup):
    """Measure tabs the agent left behind, then close them and verify we are back to `before`."""
    app = APP_FOR[agent]
    after = tab_snapshot(app)
    if before is None or after is None:
        return {"measured": False}
    new = {i: u for i, u in after.items() if i not in before}
    hosts = task_hosts(task, traj)
    ours_new = {i: u for i, u in new.items() if attributable(u, hosts)}
    left_by_agent = len(ours_new)
    try:
        harness_cleanup()
    except Exception:
        pass
    mid = tab_snapshot(app) or {}
    still = [i for i in ours_new if i in mid]
    if still:
        close_tabs(app, still)
    final = tab_snapshot(app) or {}
    remaining = [i for i in ours_new if i in final]
    return {"measured": True, "tabs_before": len(before), "tabs_after_agent": len(after),
            "left_by_agent": left_by_agent, "left_urls": sorted(set(ours_new.values()))[:10],
            "closed_by_harness": left_by_agent - len(remaining), "remaining_after_cleanup": len(remaining),
            "tabs_after_cleanup": len(final), "unattributed_new_tabs": len(new) - left_by_agent,
            "back_to_baseline": len(remaining) == 0}


# ---------------------------------------------------------------- judge

FAILURE_CATEGORIES = ["none", "wrong_answer", "incomplete", "gave_up", "timeout", "navigation", "element_not_found",
                      "interaction_failed", "iframe_or_shadow", "dialog_or_popup", "download_or_upload", "waiting_or_timing",
                      "scroll_or_pagination", "tool_error_or_infra", "blocked_or_captcha", "hallucination", "other"]

JUDGE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["success", "score", "reason", "failure_category"],
    "properties": {
        "success": {"type": "boolean"},
        "score": {"type": "number"},
        "reason": {"type": "string"},
        "failure_category": {"type": "string", "enum": FAILURE_CATEGORIES},
    },
}


def judge(task, res, traj, tdir):
    if task.get("answer_key"):
        criteria = f"ANSWER KEY (ground truth):\n{task['answer_key']}"
        rule = ("success=true only if the final answer contains every required value in the answer key "
                "(formatting/wording differences are fine; numeric values must match unless the key allows a range).")
    else:
        criteria = f"KEY POINTS the task requires (Online-Mind2Web / WebJudge style):\n{task['key_points']}"
        rule = ("success=true only if the trajectory shows the agent actually satisfied every key point on the real website "
                "(correct site, every filter/constraint applied, the right result reached) and the final answer reports it. "
                "Be strict like WebJudge: missing any filter or constraint is a failure. Do not give credit for answers that "
                "are not supported by what the trajectory shows.")
    t = traj[-80:]
    prompt = f"""You are a strict grader for a web-browsing agent benchmark.

TASK given to the agent:
{task['prompt']}

{criteria}

AGENT FINAL ANSWER:
{res['final'] or '(none)'}

AGENT RUN FACTS: timed_out={res['timed_out']} exit={res['exit']} tool_steps={res['steps']} errors={res['errors']}

AGENT TRAJECTORY (last {len(t)} entries, truncated):
{chr(10).join(t)}

{rule}
score: 1.0 full success, 0.5 partially correct, 0 wrong. failure_category: 'none' on success, else the single best root cause from the enum (judge the cause from the trajectory: e.g. couldn't read inside an iframe -> iframe_or_shadow; never finished -> timeout/gave_up; stated values not in trajectory -> hallucination).
Do not browse or run commands; judge only from the text above."""
    schema_path = tdir / "judge-schema.json"
    schema_path.write_text(json.dumps(JUDGE_SCHEMA))
    out_path = tdir / "judge.json"
    cmd = ["codex", "exec", "--ignore-user-config", "--skip-git-repo-check", "-m", JUDGE_MODEL, "-s", "read-only",
           "-c", 'web_search="disabled"', "--output-schema", str(schema_path), "-o", str(out_path), prompt]
    for attempt in range(2):
        code, _ = run_proc(cmd, tdir / "judge.stdout.txt", tdir / "judge.stderr.txt", 300, cwd=str(tdir))
        try:
            return json.loads(out_path.read_text())
        except Exception:
            continue
    return {"success": False, "score": 0, "reason": "judge failed", "failure_category": "other"}


# ---------------------------------------------------------------- orchestration

def run_one(agent, task, run_dir, stack, run_id, rejudge=False):
    tdir = run_dir / agent / task["id"]
    tdir.mkdir(parents=True, exist_ok=True)
    meta_path = tdir / "meta.json"
    if rejudge and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        traj = json.loads((tdir / "trajectory.json").read_text())
        res = meta["result"]
    else:
        log(f"[{agent}] start {task['id']}")
        before = tab_snapshot(APP_FOR[agent])
        if agent == "aside":
            res, traj = run_aside(task, tdir)
            cleanup = lambda: None
        else:
            res, traj = run_ours(task, tdir, stack, run_id)
            cleanup = lambda: finalize_obu(stack, res["session_id"], profile_for(task))
        res["tabs"] = hygiene(agent, task, before, traj, cleanup)
        (tdir / "trajectory.json").write_text(json.dumps(traj, indent=1, ensure_ascii=False))
    verdict = judge(task, res, traj, tdir)
    meta = {"agent": agent, "stack": stack if agent == "ours" else "aside", "task_id": task["id"],
            "category": task["category"], "suite": task["suite"], "model": ASIDE_MODEL if agent == "aside" else AGENT_MODEL,
            "judge_model": JUDGE_MODEL, "result": res, "verdict": verdict}
    meta_path.write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    tabs = res.get("tabs") or {}
    log(f"[{agent}] done  {task['id']}: {'PASS' if verdict.get('success') else 'FAIL'} "
        f"{res['seconds']}s steps={res['steps']} ({verdict.get('failure_category')}) "
        f"tabs_left={tabs.get('left_by_agent', '?')} clean={tabs.get('back_to_baseline', '?')}")
    return meta


def left(m):
    return ((m["result"].get("tabs") or {}).get("left_by_agent") or 0)


def summarize(run_dir):
    metas = [json.loads(p.read_text()) for p in sorted(run_dir.glob("*/*/meta.json"))]
    rows = {}
    for m in metas:
        rows.setdefault((m["suite"], m["agent"]), []).append(m)
    lines = [f"# Run {run_dir.name}", "",
             "| suite | agent | tasks | success | score | median s | median steps | median tokens | tab leaks (tasks) | tabs left (total) |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for (suite, agent), ms in sorted(rows.items()):
        ok = sum(1 for m in ms if m["verdict"].get("success"))
        lines.append(f"| {suite} | {agent} | {len(ms)} | {ok}/{len(ms)} ({100 * ok // max(len(ms), 1)}%) | "
                     f"{sum(m['verdict'].get('score', 0) for m in ms):.1f} | "
                     f"{statistics.median([m['result']['seconds'] for m in ms]):.0f} | "
                     f"{statistics.median([m['result']['steps'] for m in ms]):.0f} | "
                     f"{statistics.median([m['result']['tokens'] for m in ms]):.0f} | "
                     f"{sum(1 for m in ms if left(m) > 0)} | {sum(left(m) for m in ms)} |")
    lines += ["", "| task | category | " + " | ".join(sorted({m['agent'] for m in metas})) + " |",
              "|---|---|" + "---|" * len({m['agent'] for m in metas})]
    by_task = {}
    for m in metas:
        by_task.setdefault((m["suite"], m["task_id"], m["category"]), {})[m["agent"]] = m
    agents = sorted({m["agent"] for m in metas})
    for (suite, tid, cat), d in sorted(by_task.items()):
        cells = []
        for a in agents:
            m = d.get(a)
            cells.append("—" if not m else f"{'✅' if m['verdict'].get('success') else '❌'} {m['result']['seconds']:.0f}s "
                         f"{m['result']['steps']}st {'' if m['verdict'].get('success') else m['verdict'].get('failure_category')}"
                         f"{f' 🗂{left(m)} tab(s) left' if left(m) else ''}")
        lines.append(f"| {tid} | {cat} | " + " | ".join(cells) + " |")
    (run_dir / "summary.md").write_text("\n".join(lines) + "\n")
    (run_dir / "summary.json").write_text(json.dumps(
        [{k: m[k] for k in ("agent", "stack", "suite", "task_id", "category", "model")} |
         {"success": m["verdict"].get("success"), "score": m["verdict"].get("score"),
          "failure_category": m["verdict"].get("failure_category"), "reason": m["verdict"].get("reason"),
          "seconds": m["result"]["seconds"], "steps": m["result"]["steps"], "tokens": m["result"]["tokens"],
          "timed_out": m["result"]["timed_out"], "tabs": m["result"].get("tabs"), "final": m["result"]["final"][:500]} for m in metas], indent=1,
        ensure_ascii=False))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default="both", choices=["aside", "ours", "both"])
    ap.add_argument("--suite", default="hard", choices=["hard", "mind2web", "all"])
    ap.add_argument("--tasks", default="")
    ap.add_argument("--stack", default=os.environ.get("BENCH_STACK", "obu"), choices=["obu", "obu-agent"])
    ap.add_argument("--concurrency", type=int, default=1, help="per agent; >1 makes tab hygiene attribution unreliable")
    ap.add_argument("--run", default="", help="run id (reuse to resume/rejudge)")
    ap.add_argument("--rejudge", action="store_true", help="re-run only the judge on existing results")
    ap.add_argument("--skip-existing", action="store_true")
    a = ap.parse_args()

    run_id = a.run or time.strftime("%Y%m%d-%H%M%S")
    run_dir = BENCH / "results" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    suites = ["hard", "mind2web"] if a.suite == "all" else [a.suite]
    tasks = [t for s in suites for t in load_tasks(s, a.tasks)]
    if not tasks:
        raise SystemExit("no tasks matched")
    fx = ensure_fixtures() if any(t["suite"] == "hard" for t in tasks) else None
    ensure_upload_file()
    agents = ["aside", "ours"] if a.agent == "both" else [a.agent]
    log(f"run {run_id}: {len(tasks)} tasks × {agents} (agent model {AGENT_MODEL}, aside model {ASIDE_MODEL}, "
        f"judge {JUDGE_MODEL}, stack {a.stack})")
    try:
        pools = {ag: cf.ThreadPoolExecutor(max_workers=a.concurrency) for ag in agents}
        futs = []
        for t in tasks:
            for ag in agents:
                if a.skip_existing and (run_dir / ag / t["id"] / "meta.json").exists() and not a.rejudge:
                    continue
                futs.append(pools[ag].submit(run_one, ag, t, run_dir, a.stack, run_id, a.rejudge))
        for f in cf.as_completed(futs):
            try:
                f.result()
            except Exception as e:  # keep going; one task must not kill the run
                log(f"task crashed: {e!r}")
        for p in pools.values():
            p.shutdown()
    finally:
        if fx:
            fx.terminate()
    print(summarize(run_dir))


if __name__ == "__main__":
    main()
