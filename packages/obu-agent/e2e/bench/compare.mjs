#!/usr/bin/env node
// Compare a micro-bench result with today's baseline (repo bench/baseline.json, round 0)
// and the PLAN D6 targets. Usage: node e2e/bench/compare.mjs [results/<sha>.json] [baseline.json]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const latest = () => { const d = join(here, "results"); const fs = readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => join(d, f)); fs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); return fs[0]; };
const curPath = process.argv[2] ?? latest();
const basePath = process.argv[3] ?? join(here, "../../../../bench/baseline.json");
if (!curPath) { console.error("no results yet: run `pnpm --filter obu-agent bench:micro`"); process.exit(1); }
const cur = JSON.parse(readFileSync(curPath, "utf8")).results;
let base = {}; try { base = JSON.parse(readFileSync(basePath, "utf8")).results; } catch {}

// [op, baseline key (closest equivalent today), D6 p50 target ms, note]
const ROWS = [
  ["open_tab", "open_tab_to_loaded", 700, "to interactive"],
  ["snapshot_interactive", null, 100, "baseline: no snapshot exists (agent hand-writes CDP)"],
  ["snapshot_full", null, null, ""],
  ["click", "cdp_click_dispatch", 350, "now incl. actionability + settle + diff; baseline raw dispatch only"],
  ["click_no_snapshot", "cdp_click_dispatch", 350, ""],
  ["fill", null, null, ""],
  ["type_50_chars", null, null, ""],
  ["screenshot", "screenshot_background_jpeg70", 400, ""],
  ["screenshot_background", "screenshot_background_jpeg70", 400, "non-active owned tab"],
  ["evaluate", "attach_then_evaluate", null, "baseline attached before every call"],
];
const f = (v) => (v === undefined || v === null || Number.isNaN(v) ? "—" : String(Math.round(v * 10) / 10));
const lines = [["op", "baseline p50/p95", "now p50/p95/p99", "target p50", "status", "note"]];
for (const [op, bk, target, note] of ROWS) {
  const c = cur[op] ?? {}, b = bk ? base[bk] : null;
  const status = c.pending ? "PENDING" : !c.n ? "—" : target == null ? "info" : c.p50 <= target ? "PASS" : "FAIL";
  lines.push([op, b ? `${f(b.p50)}/${f(b.p95)}` : "—", c.n ? `${f(c.p50)}/${f(c.p95)}/${f(c.p99)}` : (c.pending ?? "—").slice(0, 40), target ? `< ${target}` : "—", status, note]);
}
if (cur.parallel_4_agents) lines.push(["parallel_4_agents", "—", `p50 ${f(cur.parallel_4_agents.p50)} ms, ${cur.parallel_4_agents.opsPerSec} ops/s`, "no cross-talk", "info", "open+snapshot+5 clicks each"]);
if (cur.focus_theft) lines.push(["focus_theft", "—", `${cur.focus_theft.thefts} in ${cur.focus_theft.samples} samples`, "0", cur.focus_theft.thefts === 0 ? "PASS" : "FAIL", ""]);
if (cur.leftover_bench_tabs !== undefined) lines.push(["leftover_tabs", "—", String(cur.leftover_bench_tabs), "0", cur.leftover_bench_tabs === 0 ? "PASS" : "FAIL", "after session.close"]);
const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => String(l[i]).length)));
const row = (l) => "| " + l.map((x, i) => String(x).padEnd(widths[i])).join(" | ") + " |";
console.log(`current: ${curPath}\nbaseline: ${basePath}\n`);
console.log(row(lines[0])); console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
for (const l of lines.slice(1)) console.log(row(l));
