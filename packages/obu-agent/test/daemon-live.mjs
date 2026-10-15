#!/usr/bin/env node
// WS-C live acceptance against Chrome for Testing (headful, throwaway profile),
// through the real daemon process + DirectCdpBackend. Never touches the user's
// Chrome. Usage: pnpm --filter obu-agent test:live   (OBU_CHROME=<binary> to override)
//
// Checks: isolated world + bundle injection across navigations, OOPIF child
// sessions, 1440x900 owned viewport, two sessions in parallel (wall ≈ max),
// same-tab serialisation, alert() never hangs and is reported, kill -9 of a
// client → owned tabs closed within the 60 s lease while borrowed tabs stay,
// MCP stdio proxy end to end.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { ObuAgentClient } from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const MAIN = join(here, "..", "dist", "daemon", "main.js");
const CDP_PORT = Number(process.env.OBU_CDP_PORT ?? 9430);
const PORT_A = 47230;
const PORT_B = 47231;
const results = [];
const started = [];

function findChrome() {
  if (process.env.OBU_CHROME) return process.env.OBU_CHROME;
  // Playwright's CfT first (kept current by `playwright install`), then puppeteer's.
  const roots = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/puppeteer/chrome")];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-mac"]) {
        const bin = join(root, dir, sub, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
        if (existsSync(bin)) found.push({ root, dir, bin });
      }
    }
  }
  // Stable within a root (newest first); roots keep their priority order.
  found.sort((a, b) => (a.root === b.root ? b.dir.localeCompare(a.dir, undefined, { numeric: true }) : roots.indexOf(a.root) - roots.indexOf(b.root)));
  if (!found.length) throw new Error("Chrome for Testing not found; set OBU_CHROME");
  return found[0].bin;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail });
    console.log(`✔ ${name} (${Date.now() - t0} ms)${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(error?.stack ?? error) });
    console.log(`✖ ${name}: ${error?.message ?? error}`);
  }
}

// --- fixture site (two origins => cross-origin iframe is an OOPIF) ---------
const pages = {
  "/main.html": `<!doctype html><title>Main fixture</title><h1 id=ready>ready</h1>
    <script>window.pageSecret = 42;</script>
    <button id=b onclick="document.title='clicked'">Go</button>
    <iframe id=f src="http://127.0.0.1:${PORT_B}/child.html" width=400 height=200></iframe>`,
  "/child.html": `<!doctype html><title>Child</title><p>child frame</p><input id=c>`,
  "/plain.html": `<!doctype html><title>Plain</title><p>plain</p>`,
};
function serve(port, host) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/slow") {
      setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); }, 800);
      return;
    }
    const body = pages[path];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
    res.end(body ?? "nf");
  });
  return new Promise((r) => server.listen(port, host, () => r(server)));
}

// --- tiny test bundle (WS-D ships the real one) ------------------------------
const BUNDLE = `(() => { if (globalThis.__obu && globalThis.__obu.version === "file") return;
  globalThis.__obu = { version: "file",
    takeSnapshot: () => ({ yaml: "- document", refs: 0, iframes: [] }),
    deref: (ref) => document.getElementById(ref.replace(/^f\\d+/, "")) ,
    settleProbe: () => ({ readyState: document.readyState, interactiveCount: 0, textLen: 0, mutationRatio: 0, landmarks: 0 }) };
})();`;

async function json(path) {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`, path.startsWith("/json/new") ? { method: "PUT" } : {});
  return res.json();
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "obu-ws-c-live-"));
  const bundleFile = join(tmp, "bundle.js");
  writeFileSync(bundleFile, BUNDLE);
  const servers = [await serve(PORT_A, "localhost"), await serve(PORT_B, "127.0.0.1")];
  const chrome = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(tmp, "chrome-profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      "--site-per-process",
      "--use-mock-keychain",
      "--password-store=basic",
      "--window-size=1200,800",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  started.push(chrome);
  for (let i = 0; i < 300; i++) {
    try {
      await json("/json/version");
      break;
    } catch {
      await sleep(100);
    }
  }
  const socket = join(tmp, "agent.sock");
  const daemon = spawn(process.execPath, [MAIN, "--backend", "direct", "--cdp-endpoint", `http://127.0.0.1:${CDP_PORT}`, "--socket", socket, "--state", join(tmp, "state.sqlite"), "--artifacts", join(tmp, "art"), "--bundle-file", bundleFile], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  started.push(daemon);
  let daemonLog = "";
  daemon.stderr.on("data", (d) => (daemonLog += d));
  for (let i = 0; i < 100 && !existsSync(socket); i++) await sleep(50);
  const token = readFileSync(join(tmp, "agent.token"), "utf8").trim();
  const client = await new ObuAgentClient(socket, { token }).connect();
  const A = `http://localhost:${PORT_A}`;

  let s1tab;
  await check("daemon.info over authenticated socket", async () => {
    const info = await client.call("daemon.info", {});
    assert.equal(info.extension.connected, true);
    return `chrome ${info.extension.version}`;
  });

  await check("tabs.open (background, owned) + wait selector", async () => {
    await client.call("session.open", { sessionId: "s1", label: "Live one" });
    const t0 = Date.now();
    s1tab = await client.call("tabs.open", { sessionId: "s1", url: `${A}/main.html` });
    const openMs = Date.now() - t0;
    const w = await client.call("wait", { sessionId: "s1", for: "selector", selector: "#ready", timeoutMs: 10_000 });
    assert.equal(w.ok, true);
    return `open ${openMs} ms, interactive at ${Date.now() - t0} ms, tab ${s1tab.tabId} target ${s1tab.targetId}`;
  });

  await check("I8 + isolated world: __obu only in utility world, page globals invisible there", async () => {
    const iso = await client.call("evaluate", { sessionId: "s1", expression: "[typeof __obu, __obu && __obu.version, typeof window.pageSecret, document.title]" });
    assert.deepEqual(iso.value, ["object", "file", "undefined", "Main fixture"]);
    const page = await client.call("evaluate", { sessionId: "s1", world: "page", expression: "[typeof __obu, window.pageSecret]" });
    assert.deepEqual(page.value, ["undefined", 42]);
  });

  await check("bundle re-injected after navigation (addScriptToEvaluateOnNewDocument + health check)", async () => {
    const nav = await client.call("navigate", { sessionId: "s1", url: `${A}/main.html?second`, waitUntil: "load" });
    assert.equal(nav.ok, true);
    const iso = await client.call("evaluate", { sessionId: "s1", expression: "[__obu.version, location.search]" });
    assert.deepEqual(iso.value, ["file", "?second"]);
    const back = await client.call("navigate", { sessionId: "s1", op: "back", waitUntil: "load" });
    assert.equal(back.ok, true);
    const after = await client.call("evaluate", { sessionId: "s1", expression: "[__obu.version, location.search]" });
    assert.deepEqual(after.value, ["file", ""]);
    return `navigate ${nav.settled.ms} ms`;
  });

  await check("I6: owned tab viewport is 1440x900", async () => {
    const v = await client.call("evaluate", { sessionId: "s1", expression: "[innerWidth, innerHeight]" });
    assert.deepEqual(v.value, [1440, 900]);
  });

  await check("OOPIF: child session reachable via frameRef (flat sessions)", async () => {
    const r = await client.call("cdp", { sessionId: "s1", method: "Runtime.evaluate", params: { expression: "location.href", returnByValue: true }, frameRef: "f1" });
    assert.match(r.result.result.value, new RegExp(`127\\.0\\.0\\.1:${PORT_B}/child\\.html`));
    const denied = await client.call("cdp", { sessionId: "s1", method: "Runtime.enable" }).catch((e) => e.data?.code);
    assert.equal(denied, "cdp_denied");
  });

  await check("I3: two sessions on different tabs run in parallel (wall ≈ max); same tab serialises", async () => {
    await client.call("session.open", { sessionId: "s2", label: "Live two" });
    await client.call("tabs.open", { sessionId: "s2", url: `${A}/plain.html` });
    await client.call("wait", { sessionId: "s2", for: "text", text: "plain", timeoutMs: 10_000 });
    // Network-bound (800 ms server delay), not timer-bound: background tabs throttle timers.
    const slow = "fetch('/slow?' + Math.random()).then((r) => r.text())";
    let t0 = Date.now();
    await Promise.all([
      client.call("evaluate", { sessionId: "s1", world: "page", expression: slow, awaitPromise: true }),
      client.call("evaluate", { sessionId: "s2", world: "page", expression: slow, awaitPromise: true }),
    ]);
    const parallel = Date.now() - t0;
    t0 = Date.now();
    await Promise.all([
      client.call("evaluate", { sessionId: "s1", world: "page", expression: slow, awaitPromise: true }),
      client.call("evaluate", { sessionId: "s1", world: "page", expression: slow, awaitPromise: true }),
    ]);
    const serial = Date.now() - t0;
    assert.ok(parallel < 1300, `parallel ${parallel}`);
    assert.ok(serial >= 1550, `serial ${serial}`);
    const cross = await client.call("evaluate", { sessionId: "s2", tabId: s1tab.tabId, expression: "1" }).catch((e) => e.data?.code);
    assert.equal(cross, "tab_not_owned");
    return `parallel ${parallel} ms vs serial ${serial} ms`;
  });

  await check("dialogs: alert() never hangs a call and is reported in the result", async () => {
    const t0 = Date.now();
    const r = await client.call("evaluate", { sessionId: "s1", world: "page", expression: "alert('hello'); confirm('sure?') ? 'yes' : 'no'" });
    assert.equal(r.value, "yes");
    assert.ok(Date.now() - t0 < 3_000);
    assert.deepEqual(r.events.filter((e) => e.type === "dialog").map((e) => [e.dialogType, e.message, e.action]), [
      ["alert", "hello", "accepted"],
      ["confirm", "sure?", "accepted"],
    ]);
    // Background tabs clamp timers to >= 1 s (Chrome throttling), so give it 1.5 s.
    await client.call("evaluate", { sessionId: "s1", world: "page", expression: "setTimeout(() => alert('later'), 50), 1" });
    await sleep(1_500);
    const next = await client.call("evaluate", { sessionId: "s1", expression: "1" });
    assert.deepEqual(next.events.map((e) => [e.type, e.message]), [["dialog", "later"]]);
    return `${Date.now() - t0} ms`;
  });

  await check("tabs.list scope browser sees the user's tabs read-only", async () => {
    const user = await json(`/json/new?${A}/plain.html`);
    const list = await client.call("tabs.list", { sessionId: "s1", scope: "browser" });
    assert.ok(list.tabs.some((t) => t.url.includes("plain.html") && t.ownership === undefined), JSON.stringify(list.tabs));
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${user.id}`);
  });

  await check("MCP stdio proxy end to end (initialize, tools/list, tools/call, finalize on EOF)", async () => {
    const mcp = spawn(process.execPath, [MAIN, "mcp", "--attach", "--socket", socket, "--session", "mcp-live", "--label", "MCP live", "--no-spawn"], { stdio: ["pipe", "pipe", "inherit"] });
    started.push(mcp);
    const rl = createInterface({ input: mcp.stdout });
    const waiting = new Map();
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    });
    let id = 0;
    const rpc = (method, params) =>
      new Promise((resolve) => {
        const my = ++id;
        waiting.set(my, resolve);
        mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, params })}\n`);
      });
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live", version: "1" } });
    assert.equal(init.result.serverInfo.name, "obu-agent");
    const tools = await rpc("tools/list", {});
    assert.equal(tools.result.tools.length, 13);
    const open = await rpc("tools/call", { name: "browser_tabs_open", arguments: { url: `${A}/plain.html` } });
    assert.ok(!open.result.isError, open.result.content[0].text);
    const targetId = JSON.parse(open.result.content[0].text.split("\n")[0]).targetId;
    await rpc("tools/call", { name: "browser_wait", arguments: { for: "text", text: "plain" } });
    const ev = await rpc("tools/call", { name: "browser_evaluate", arguments: { expression: "document.title" } });
    assert.match(ev.result.content[0].text, /"value":"Plain"/);
    mcp.stdin.end();
    await new Promise((r) => mcp.once("exit", r));
    await sleep(300);
    const live = await json("/json/list");
    assert.ok(!live.some((t) => t.id === targetId), "MCP session tabs closed on EOF");
  });

  await check("kill -9 of a client mid-task: owned tabs closed within the 60 s lease, borrowed tab stays", async () => {
    const user = await json(`/json/new?${encodeURIComponent(`${A}/plain.html?user=1`)}`);
    await sleep(500);
    const userTabId = (await client.call("tabs.list", { sessionId: "s1", scope: "browser" })).tabs.find((t) => t.url.includes("user=1")).tabId;
    const script = `
      import { ObuAgentClient } from ${JSON.stringify(join(here, "..", "dist", "index.js"))};
      const c = await new ObuAgentClient(${JSON.stringify(socket)}, { token: ${JSON.stringify(token)} }).connect();
      await c.call("session.open", { sessionId: "doomed" });
      const t = await c.call("tabs.open", { sessionId: "doomed", url: ${JSON.stringify(`${A}/main.html?doomed=1`)} });
      await c.call("tabs.attach", { sessionId: "doomed", tabId: ${userTabId} });
      console.log(JSON.stringify({ targetId: t.targetId }));
      await c.call("evaluate", { sessionId: "doomed", tabId: t.tabId, world: "page", expression: "new Promise(() => {})", awaitPromise: true });
    `;
    const victim = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    started.push(victim);
    const first = await new Promise((resolve) => createInterface({ input: victim.stdout }).once("line", resolve));
    const { targetId } = JSON.parse(first);
    await sleep(300);
    victim.kill("SIGKILL");
    const killedAt = Date.now();
    let goneAfter = -1;
    while (Date.now() - killedAt < 75_000) {
      const list = await json("/json/list");
      if (!list.some((t) => t.id === targetId)) {
        goneAfter = Date.now() - killedAt;
        break;
      }
      // The other live sessions keep heartbeating (15 s cadence) while we wait.
      await client.call("session.heartbeat", { sessionId: "s1" });
      await client.call("session.heartbeat", { sessionId: "s2" });
      await sleep(1_000);
    }
    assert.ok(goneAfter >= 0 && goneAfter <= 62_000, `owned tab gone after ${goneAfter} ms`);
    const list = await json("/json/list");
    assert.ok(list.some((t) => t.id === user.id), "borrowed user tab still open");
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${user.id}`);
    return `owned tab closed ${goneAfter} ms after kill -9`;
  });

  await check("session.close finalizes everything this run opened", async () => {
    const r1 = await client.call("session.close", { sessionId: "s1" });
    const r2 = await client.call("session.close", { sessionId: "s2" });
    assert.ok(r1.closedTabIds.length >= 1 && r2.closedTabIds.length === 1);
    const info = await client.call("daemon.info", {});
    assert.equal(info.sessions, 0);
  });

  client.close();
  for (const server of servers) server.close();
  writeFileSync(join(tmp, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed (artifacts: ${tmp})`);
  if (failed.length) console.log(daemonLog.slice(-4000));
  return failed.length ? 1 : 0;
}

// Never leave a Chrome or daemon behind (Ctrl-C included).
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of started) if (child.exitCode === null) child.kill("SIGKILL");
    process.exit(130);
  });
}

let code = 1;
try {
  code = await main();
} catch (error) {
  console.error(error);
} finally {
  for (const child of started.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await sleep(300);
  for (const child of started) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}
process.exit(code);
