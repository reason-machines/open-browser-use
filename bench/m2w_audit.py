#!/usr/bin/env python3
"""Audit the Online-Mind2Web subset of a run: per task, is it feasible on today's site, was our judge
over-strict vs WebJudge, did agents hit anti-bot/region walls, and what did the missing start URL cost?

Evidence per task: our judge verdicts + reasons + finals for every arm, anti-bot markers grepped from the
raw trajectories, and Aside's own public result for the same task id (at-inc/aside-benchmarks, which
reports 297/300 with gpt-5.5 / thinking high / start URL given) as a feasibility reference.
Auditor: codex gpt-6.1-sol with a JSON schema. Writes results/M2W-AUDIT.md + results/<run>/m2w-audit.json.
"""
import json, re, subprocess, sys, base64
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runner  # noqa: E402

BLOCK = re.compile(r"captcha|access denied|unusual traffic|verify you are (a )?human|are you a robot|request blocked|"
                   r"403 forbidden|not available in your (country|region)|cloudflare|perimeterx|akamai|datadome", re.I)
SCHEMA = {"type": "object", "additionalProperties": False,
          "required": ["feasible_today", "judge_overstrict", "antibot", "start_url_mattered", "fair_outcome", "notes"],
          "properties": {
              "feasible_today": {"type": "string", "enum": ["yes", "no", "unclear"]},
              "judge_overstrict": {"type": "array", "items": {"type": "string"}},
              "antibot": {"type": "array", "items": {"type": "string"}},
              "start_url_mattered": {"type": "boolean"},
              "fair_outcome": {"type": "object", "additionalProperties": {"type": "string", "enum": ["pass", "fail", "n/a"]}},
              "notes": {"type": "string"}}}


def aside_public(task_id):
    try:
        r = subprocess.run(["gh", "api", f"repos/at-inc/aside-benchmarks/contents/mind2web/results/{task_id}/result.json",
                            "--jq", ".content"], capture_output=True, text=True, timeout=60)
        d = json.loads(base64.b64decode(r.stdout))
        return {k: d.get(k) for k in ("website", "outcome", "graderVerdict", "graderReasoning", "final_result_response")} | {
            "action_history_tail": (d.get("action_history") or [])[-15:]}
    except Exception as e:
        return {"error": str(e)[:200]}


def main(run):
    rd = runner.BENCH / "results" / run
    tasks = {t["id"]: t for t in json.loads((runner.BENCH / "tasks/mind2web.json").read_text())}
    rows = []
    for tid, t in tasks.items():
        arms = {}
        for meta_p in sorted(rd.glob(f"*/{tid}/meta.json")):
            m = json.loads(meta_p.read_text())
            raw = "".join(p.read_text(errors="replace") for p in meta_p.parent.glob("*") if p.name in ("events.ndjson", "transcript.jsonl"))
            hits = sorted({h.lower() for h in BLOCK.findall(raw)})
            arms[m["agent"]] = {"success": m["verdict"].get("success"), "reason": m["verdict"].get("reason"),
                                "final": m["result"]["final"][:1200], "steps": m["result"]["steps"], "antibot_markers": hits,
                                "prompt_given": m["result"].get("prompt_given") or "(no start URL given)"}
        pub = aside_public(t["source"]["task_id"])
        prompt = f"""You audit one Online-Mind2Web task from our benchmark run (date 2026-10-15, Mac in San Francisco).

TASK: {t['prompt']}
OFFICIAL WEBSITE: {t.get('website')}   LEVEL: {t['source'].get('level')}
KEY POINTS: {t['key_points']}

OUR RUN, per agent arm (judge verdict, judge reason, final answer, steps, anti-bot markers found in raw logs, prompt given):
{json.dumps(arms, indent=1, ensure_ascii=False)}

ASIDE'S PUBLIC RESULT for the same task (at-inc/aside-benchmarks; their run had the start URL, thinking=high, their own LLM grader):
{json.dumps(pub, indent=1, ensure_ascii=False)[:6000]}

Answer:
- feasible_today: is the task still doable on today's site (yes/no/unclear; use Aside's public run as recent evidence)?
- judge_overstrict: list the arms whose FAIL looks over-strict relative to the WebJudge protocol (key points satisfied, evidence present but judge demanded more).
- antibot: arms that were blocked by captcha/anti-bot/region walls.
- start_url_mattered: did not giving the start URL plausibly cause a failure (wrong site, time spent searching)?
- fair_outcome: for each arm, your best estimate of the outcome under a fair protocol (pass/fail/n/a).
- notes: one or two sentences."""
        out = rd / f"_audit_{tid}.json"
        schema = rd / "_audit_schema.json"
        schema.write_text(json.dumps(SCHEMA))
        subprocess.run(["codex", "exec", "--ignore-user-config", "--skip-git-repo-check", "-m", runner.JUDGE_MODEL, "-s", "read-only",
                        "-c", 'web_search="disabled"', "--output-schema", str(schema), "-o", str(out), prompt],
                       stdin=subprocess.DEVNULL, capture_output=True, timeout=600, cwd=str(rd))
        try:
            a = json.loads(out.read_text())
        except Exception:
            a = {"feasible_today": "unclear", "judge_overstrict": [], "antibot": [], "start_url_mattered": False,
                 "fair_outcome": {}, "notes": "auditor failed"}
        out.unlink(missing_ok=True)
        rows.append({"id": tid, "task": t["prompt"].split("\n")[0], "website": t.get("website"), "level": t["source"].get("level"),
                     "arms": {k: v["success"] for k, v in arms.items()}, "aside_public": pub.get("graderVerdict"), **a})
        print(tid, a.get("feasible_today"), a.get("fair_outcome"), flush=True)
    (rd / "_audit_schema.json").unlink(missing_ok=True)
    (rd / "m2w-audit.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))
    return rows


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "baseline-v2")
