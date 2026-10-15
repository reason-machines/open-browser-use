#!/usr/bin/env node
// D6 micro-bench against the obu-agent daemon (same environment as e2e: CfT + fork extension
// + dev host + daemon, or OBU_AGENT_SOCKET / E2E_REAL_PROFILE=1). Writes
// e2e/bench/results/<sha>.json; compare with `node e2e/bench/compare.mjs`.
// Usage: node e2e/bench/micro.mjs [--runs 30] [--out path]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getEnv, teardown, pct, refOf } from "../lib/harness.mjs";
import { startFocusSampler } from "../lib/focus.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const RUNS = Number(arg("runs", 30));
const here = fileURLToPath(new URL(".", import.meta.url));
let sha = "unknown"; try { sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here }).toString().trim(); } catch {}
const out = arg("out", join(here, "results", `${sha}.json`));

const results = {};
const stat = (xs) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(2), p95: +pct(xs, 95).toFixed(2), p99: +pct(xs, 99).toFixed(2), max: +Math.max(...xs).toFixed(2) });

async function measure(name, n, fn) {
  const ms = []; let failures = 0, lastError = null;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    try { await fn(i); ms.push(performance.now() - t0); }
    catch (e) {
      failures++; lastError = `${e.code ?? e.data?.code ?? ""} ${e.message}`.trim();
      if ((e.code ?? e.data?.code) === "not_implemented" || (e.code ?? e.data?.code) === "extension_disconnected") break;
    }
  }
  results[name] = ms.length ? { ...stat(ms), failures } : { n: 0, failures, pending: lastError };
  if (lastError) results[name].lastError = lastError;
  process.stderr.write(`${name.padEnd(24)} ${ms.length ? `p50 ${results[name].p50} p95 ${results[name].p95} ms` : `PENDING ${lastError}`}\n`);
}

let exitCode = 0;
try {
  const env = await getEnv();
  if (env.unavailable) throw new Error(env.unavailable);
  const client = env.client;
  const url = env.fixtures.url("bench.html");
  const focus = env.cdp ? await startFocusSampler(env) : null;
  const sid = `bench-${process.pid}`;
  const sessions = [sid];
  const pendingWhy = await client.call("session.open", { sessionId: sid, label: "bench" }).then(() => null, (e) => `${e.code ?? e.data?.code ?? ""} ${e.message}`.trim());
  if (pendingWhy) for (const op of ["open_tab", "snapshot_interactive", "snapshot_full", "click", "click_no_snapshot", "fill", "type_50_chars", "screenshot", "screenshot_background", "evaluate"]) results[op] = { n: 0, failures: 0, pending: pendingWhy };
  const opened = [];
  if (!pendingWhy) await measure("open_tab", Math.min(RUNS, 20), async () => {
    const r = await client.call("tabs.open", { sessionId: sid, url });
    opened.push(r.tabId);
    if (opened.length > 2) await client.call("tabs.close", { sessionId: sid, tabId: opened.shift() });
  });
  const main = pendingWhy ? null : await client.call("tabs.open", { sessionId: sid, url }).catch(() => null);
  if (main) {
    const bg = await client.call("tabs.open", { sessionId: sid, url, makeActive: false });
    const tabId = main.tabId;
    await measure("snapshot_interactive", RUNS, () => client.call("snapshot", { sessionId: sid, tabId, interactive: true }));
    await measure("snapshot_full", RUNS, () => client.call("snapshot", { sessionId: sid, tabId }));
    const tree = (await client.call("snapshot", { sessionId: sid, tabId })).tree;
    const inc = refOf(tree, /button "Increment"/), q = refOf(tree, /textbox "Query"/);
    await measure("click", RUNS, () => client.call("act", { sessionId: sid, tabId, action: "click", ref: inc }));
    await measure("click_no_snapshot", RUNS, () => client.call("act", { sessionId: sid, tabId, action: "click", ref: inc, snapshot: "none" }));
    await measure("fill", RUNS, (i) => client.call("act", { sessionId: sid, tabId, action: "fill", ref: q, value: `query ${i}` }));
    await measure("type_50_chars", Math.min(RUNS, 10), () => client.call("act", { sessionId: sid, tabId, action: "type", ref: q, value: "x".repeat(50), snapshot: "none" }));
    await measure("screenshot", Math.min(RUNS, 20), () => client.call("screenshot", { sessionId: sid, tabId }));
    await measure("screenshot_background", Math.min(RUNS, 20), () => client.call("screenshot", { sessionId: sid, tabId: bg.tabId }));
    await measure("evaluate", RUNS, () => client.call("evaluate", { sessionId: sid, tabId, expression: "document.title" }));
    // 4 agents in parallel: each opens a tab, snapshots, clicks 5x. Throughput = ops/sec.
    const par = [];
    for (let round = 0; round < 3; round++) {
      const ids = [0, 1, 2, 3].map((k) => `${sid}-p${round}-${k}`); sessions.push(...ids);
      const t0 = performance.now(); let ops = 0;
      await Promise.all(ids.map(async (id) => {
        await client.call("session.open", { sessionId: id, label: `bench-par-${id.slice(-2)}` });
        const t = await client.call("tabs.open", { sessionId: id, url }); ops++;
        const ref = refOf((await client.call("snapshot", { sessionId: id, tabId: t.tabId, interactive: true })).tree, /button "Increment"/); ops++;
        for (let k = 0; k < 5; k++) { await client.call("act", { sessionId: id, tabId: t.tabId, action: "click", ref, snapshot: "none" }); ops++; }
        await client.call("session.close", { sessionId: id });
      }));
      par.push({ ms: performance.now() - t0, ops });
    }
    results.parallel_4_agents = { n: par.length, p50: +pct(par.map((p) => p.ms), 50).toFixed(1), opsPerSec: +((par.reduce((a, p) => a + p.ops, 0) / par.reduce((a, p) => a + p.ms, 0)) * 1000).toFixed(1) };
    process.stderr.write(`parallel_4_agents        ${JSON.stringify(results.parallel_4_agents)}\n`);
  }
  for (const id of sessions) await client.call("session.close", { sessionId: id }).catch(() => {});
  if (focus) { const f = await focus.stop(); results.focus_theft = { thefts: f.thefts, samples: f.samples }; process.stderr.write(`focus_theft              ${JSON.stringify(results.focus_theft)}\n`); }
  if (env.cdp) results.leftover_bench_tabs = (await (await fetch(`http://127.0.0.1:${env.cdpPort}/json/list`)).json()).filter((x) => x.type === "page" && x.url.includes("bench.html")).length;
  const doc = { info: { measuredAt: new Date().toISOString(), sha, mode: env.mode, daemon: env.info, runs: RUNS, notes: env.notes }, results };
  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  process.stderr.write(`wrote ${out}\n`);
} catch (e) {
  process.stderr.write(`bench failed: ${e.stack ?? e}\n`); exitCode = 1;
} finally {
  await teardown();
}
process.exit(exitCode);
