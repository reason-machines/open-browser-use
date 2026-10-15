#!/usr/bin/env node
// Baseline latency of TODAY's OBU path (extension + native host relay) on this Mac.
// Usage: node bench/baseline.mjs [--socket <path>] [--runs 50] [--out bench/baseline.json]
// Opens its own background tabs in a dedicated session and finalizes (closes) them at the end.
// Never touches the user's existing tabs.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { OpenBrowserUseClient } from "../packages/open-browser-use-js/dist/index.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

function resolveSocket() {
  const explicit = arg("socket");
  if (explicit) return explicit;
  for (const dir of ["/tmp/reason-browser-use", "/tmp/open-browser-use"]) {
    const reg = `${dir}/active.json`;
    if (existsSync(reg)) return JSON.parse(readFileSync(reg, "utf8")).socketPath;
  }
  throw new Error("no active OBU socket registry found");
}

const RUNS = Number(arg("runs", "50"));
const OPEN_RUNS = Number(arg("open-runs", "20"));
const OUT = arg("out", new URL("./baseline.json", import.meta.url).pathname);
const socketPath = resolveSocket();

const page = `<!doctype html><title>obu bench</title><h1>bench</h1><p>${"lorem ipsum ".repeat(200)}</p><button id=b>go</button>`;
const server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(page); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const client = new OpenBrowserUseClient({ socketPath, sessionId: `obu-baseline-${process.pid}`, timeoutMs: 15_000 });
await client.connect();

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2), failures: 0 };
}
async function time(fn) { const t = performance.now(); await fn(); return performance.now() - t; }
async function measure(name, n, fn) {
  const samples = []; let failures = 0; const errors = new Set();
  for (let i = 0; i < n; i++) {
    try { samples.push(await time(() => fn(i))); } catch (e) { failures++; errors.add(String(e?.message ?? e).slice(0, 200)); }
  }
  const r = samples.length ? stats(samples) : { n: 0 };
  r.failures = failures; if (errors.size) r.errors = [...errors];
  console.error(name, JSON.stringify(r));
  return r;
}
const tabIdOf = (v) => (typeof v?.id === "number" ? v.id : v?.tabId);

async function waitLoaded(tabId) {
  for (let i = 0; i < 100; i++) {
    const r = await client.executeCdp(tabId, "Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
    if (r?.result?.value === "complete") return;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("load timeout");
}

const results = {};
try {
  results.ping_persistent_socket = await measure("ping", RUNS, () => client.request("ping"));
  results.getInfo = await measure("getInfo", RUNS, () => client.getInfo());

  // open_tab = createTab + attach + Page.navigate + readyState==complete (today's agent path)
  const opened = [];
  results.open_tab_to_loaded = await measure("open_tab", OPEN_RUNS, async () => {
    const tab = await client.createTab();
    const tabId = tabIdOf(tab); opened.push(tabId);
    await client.attach(tabId);
    await client.executeCdp(tabId, "Page.navigate", { url });
    await waitLoaded(tabId);
  });
  const tabId = opened[opened.length - 1];
  results.getTabs = await measure("getTabs", RUNS, () => client.getTabs());
  results.attach_then_evaluate = await measure("attach+evaluate", RUNS, async () => {
    await client.attach(tabId);
    await client.executeCdp(tabId, "Runtime.evaluate", { expression: "document.title", returnByValue: true });
  });
  results.cdp_evaluate = await measure("cdp_evaluate", RUNS, () =>
    client.executeCdp(tabId, "Runtime.evaluate", { expression: "document.title", returnByValue: true }));
  results.cdp_click_dispatch = await measure("cdp_click", RUNS, async () => {
    await client.executeCdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: 20, y: 20, button: "left", clickCount: 1 });
    await client.executeCdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 20, button: "left", clickCount: 1 });
  });
  results.screenshot_background_png = await measure("screenshot_png", Math.min(RUNS, 20), () =>
    client.executeCdp(tabId, "Page.captureScreenshot", { format: "png" }));
  results.screenshot_background_jpeg70 = await measure("screenshot_jpeg", Math.min(RUNS, 20), () =>
    client.executeCdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 70 }));

  // Process-spawn cost of the CLI path (what every Mac/cloud tool call pays today).
  results.cli_spawn_ping = await measure("cli_ping", 20, async () => {
    execFileSync("obu", ["ping", "--socket", socketPath, "--session-id", `obu-baseline-${process.pid}`], { stdio: "pipe" });
  });
} finally {
  try { await client.finalizeTabs([]); } catch (e) { console.error("finalize failed", e?.message); }
  client.close();
  server.close();
}

const info = { measuredAt: new Date().toISOString(), host: "darwin-arm64", obuInstalled: "0.1.42", socketPath, url, runs: RUNS, openRuns: OPEN_RUNS };
writeFileSync(OUT, JSON.stringify({ info, results }, null, 2) + "\n");
console.log(JSON.stringify({ info, results }, null, 2));
