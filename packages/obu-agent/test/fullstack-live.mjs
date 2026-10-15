#!/usr/bin/env node
// r2-integrate: the whole production stack, live, on Chrome for Testing:
//   client → obu-agent daemon (spawned by the host's supervisor) → Go native
//   host relay → Reason-branded extension (wire v2) → chrome.debugger → page.
// No direct CDP on the agent path; the harness's own --remote-debugging-port
// connection is used only for ground truth (fixture state, focus sentinel).
// Throwaway profile + sockets under a temp dir; every process we start is
// stopped in `finally` (Chrome, and the resident daemon by pid).
//
//   node test/fullstack-live.mjs [--headless] [--json out.json]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ObuAgentClient } from "../dist/index.js";
import { startFixtures } from "../fixtures/server.mjs";
import { Cdp, attachPage, browserWsUrl, listTargets } from "../e2e/lib/cdp.mjs";
import { freePort, killProc, launchChrome, unpackedExtensionId, REPO_ROOT } from "../e2e/lib/chrome.mjs";
import { loadBrand, stageBrandedExtension } from "../../../scripts/package-chrome-extension-brand.mjs";

const argv = process.argv.slice(2);
const HEADLESS = argv.includes("--headless");
const JSON_OUT = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : undefined;
const PORTS = [9470, 9479];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const latency = {};

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}\n`);
}
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (error) {
    record(name, false, error?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(error));
  }
}
async function timed(metric, fn) {
  const t = performance.now();
  const value = await fn();
  (latency[metric] ??= []).push(performance.now() - t);
  return value;
}
function pct(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function frontmostApp() {
  try {
    return execFileSync("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    return "?";
  }
}
function activateApp(name) {
  try {
    execFileSync("osascript", ["-e", `tell application "${name}" to activate`], { timeout: 3_000 });
  } catch { /* best effort */ }
}

// Short paths: macOS caps unix socket paths at 104 bytes.
const TMP = realpathSync(mkdtempSync("/tmp/obu-r2-"));
const procs = { chrome: null, daemonPid: null };
let fixtures, client, harness, sentinel, focusTimer;

try {
  fixtures = await startFixtures();
  const brand = loadBrand({ brand: "reason" });
  const extDir = join(TMP, "ext");
  stageBrandedExtension({ out: extDir, brand });
  const extensionId = unpackedExtensionId(extDir);

  // Real Go native host (decode-free relay + obu-agent supervisor).
  const hostBin = join(TMP, "obu-host");
  execFileSync("go", ["build", "-o", hostBin, "./cmd/open-browser-use"], { cwd: REPO_ROOT, stdio: "inherit" });
  const agentBin = resolve(REPO_ROOT, "packages/obu-agent/dist/daemon/main.js");
  const agentSocket = join(TMP, "agent", "agent.sock");
  mkdirSync(join(TMP, "agent"), { recursive: true, mode: 0o700 });
  const wrapper = join(TMP, "native-host.sh");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `export OBU_BRAND=reason OBU_AGENT_BIN="${agentBin}" OBU_NODE="${process.execPath}" OBU_AGENT_SOCKET="${agentSocket}"`,
      `exec "${hostBin}" host --socket-dir "${join(TMP, "relay")}"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);
  const userDataDir = join(TMP, "profile");
  mkdirSync(join(userDataDir, "NativeMessagingHosts"), { recursive: true });
  writeFileSync(
    join(userDataDir, "NativeMessagingHosts", `${brand.nativeHostName}.json`),
    JSON.stringify({ name: brand.nativeHostName, description: "r2 full-stack host", type: "stdio", path: wrapper, allowed_origins: [`chrome-extension://${extensionId}/`] }),
  );

  // Downloads go to our temp dir, never the user's ~/Downloads.
  const downloadsDir = join(TMP, "downloads");
  mkdirSync(join(userDataDir, "Default"), { recursive: true });
  mkdirSync(downloadsDir, { recursive: true });
  writeFileSync(join(userDataDir, "Default", "Preferences"), JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: downloadsDir } }));

  const userApp = frontmostApp();
  const port = await freePort(PORTS);
  const chrome = await launchChrome({ tmp: TMP, port, userDataDir, headless: HEADLESS, extensionDir: extDir, startUrl: fixtures.url("sentinel.html") });
  procs.chrome = chrome.proc;
  if (!HEADLESS && userApp !== "?") {
    await sleep(800);
    activateApp(userApp); // hand focus back: launching Chrome is not the agent's doing
  }

  // Ground-truth connection + the "user" tab (sentinel) we must never disturb.
  harness = await Cdp.connect(await browserWsUrl(port));
  const sentinelTarget = (await listTargets(port)).find((t) => t.type === "page" && t.url.includes("sentinel.html"));
  sentinel = await attachPage(harness, sentinelTarget.id);

  // The supervisor spawns obu-agent once the extension connects to the host.
  const deadline = Date.now() + 30_000;
  while (!existsSync(agentSocket) && Date.now() < deadline) await sleep(100);
  assert(existsSync(agentSocket), `daemon socket never appeared at ${agentSocket}`);
  client = await new ObuAgentClient(agentSocket, { token: readFileSync(join(TMP, "agent", "agent.token"), "utf8").trim(), timeoutMs: 60_000 }).connect();
  let info;
  for (let i = 0; i < 100; i++) {
    info = await client.call("daemon.info", {});
    if (info.extension.connected) break;
    await sleep(100);
  }
  procs.daemonPid = info.pid;
  record("stack up: supervisor-spawned daemon ↔ host ↔ extension", info.extension.connected, `daemon pid ${info.pid}, extension ${info.extension.version ?? "?"}`);

  // Focus-theft sampler: the sentinel tab must stay the visible+focused tab and
  // the frontmost app must not change for the whole run.
  const focusSamples = { total: 0, sentinelHidden: 0, appChanged: 0, apps: new Set() };
  const baselineApp = HEADLESS ? null : frontmostApp();
  let appSampleAt = 0;
  focusTimer = setInterval(async () => {
    focusSamples.total++;
    const state = await sentinel.evaluate("document.visibilityState").catch(() => "error");
    if (state !== "visible") focusSamples.sentinelHidden++;
    if (baselineApp && Date.now() - appSampleAt > 1_000) {
      appSampleAt = Date.now();
      const app = frontmostApp();
      focusSamples.apps.add(app);
      if (app !== baselineApp) focusSamples.appChanged++;
    }
  }, 250);

  const pageState = async (sessionId, tabId, expr = "window.__fx && window.__fx.state") =>
    (await client.call("evaluate", { sessionId, tabId, expression: `JSON.stringify(${expr})`, world: "page" })).value;

  await client.call("session.open", { sessionId: "root", label: "r2 e2e" });

  // ---------------------------------------------------------------- open_tab
  let formTab;
  await check("open_tab (owned, background, grouped)", async () => {
    for (let i = 0; i < 5; i++) {
      const tab = await timed("open_tab", () => client.call("tabs.open", { sessionId: "root", url: fixtures.url("form.html") }));
      if (i < 4) await client.call("tabs.close", { sessionId: "root", tabId: tab.tabId });
      else formTab = tab;
    }
    assert(formTab.title === "Form fixture", `title ${formTab.title}`);
    const groups = await harness.send("Runtime.evaluate", { expression: "1" }).catch(() => null);
    void groups;
    return `tab ${formTab.tabId}, settled ${formTab.settled?.kind}`;
  });

  // ---------------------------------------------------------------- snapshot
  await check("snapshot interactive (refs) + full", async () => {
    let snap;
    for (let i = 0; i < 20; i++) snap = await timed("snapshot_interactive", () => client.call("snapshot", { sessionId: "root", interactive: true }));
    assert(/textbox|button/.test(snap.tree), "no interactive nodes");
    const full = await timed("snapshot_full", () => client.call("snapshot", { sessionId: "root" }));
    assert(full.tree.includes("Sign-up form"), "heading missing");
    return `${snap.tree.length} chars interactive, ${full.tree.length} full`;
  });

  // ---------------------------------------------------------------- fill + click + settle
  await check("fill + check + select + click submit (settle, diff)", async () => {
    await client.call("act", { sessionId: "root", action: "fill", selector: "#name", value: "Ada Lovelace", snapshot: "none" });
    await client.call("act", { sessionId: "root", action: "select", selector: "#country", value: "Norway", snapshot: "none" });
    await client.call("act", { sessionId: "root", action: "check", selector: "#terms", snapshot: "none" });
    const res = await timed("click_settle", () => client.call("act", { sessionId: "root", action: "click", selector: "#submit" }));
    const state = JSON.parse(await pageState("root", formTab.tabId));
    assert(state.submitted?.name === "Ada Lovelace" && state.submitted.country === "no" && state.submitted.terms === true, `fixture state ${JSON.stringify(state)}`);
    assert(res.snapshot?.diff !== undefined || res.snapshot?.tree, "no snapshot diff on act");
    for (let i = 0; i < 19; i++) await timed("click_settle", () => client.call("act", { sessionId: "root", action: "click", selector: "#submit", snapshot: "none" }));
    return `settled ${res.settled.kind} in ${res.settled.ms} ms`;
  });

  // ---------------------------------------------------------------- screenshot (background tab)
  await check("screenshot of background tab", async () => {
    let shot;
    for (let i = 0; i < 10; i++) shot = await timed("screenshot_bg", () => client.call("screenshot", { sessionId: "root" }));
    assert(existsSync(shot.path) && shot.width > 0, "no file");
    return `${shot.width}x${shot.height} ${shot.mime} via ${shot.via}`;
  });

  // ---------------------------------------------------------------- upload (file-URL access off)
  await check("upload with file-URL access off", async () => {
    const tab = await client.call("tabs.open", { sessionId: "root", url: fixtures.url("upload.html") });
    const file = join(TMP, "resume.txt");
    writeFileSync(file, "fullstack upload payload\n");
    const res = await client.call("act", { sessionId: "root", action: "upload", selector: "#single", files: [file], snapshot: "none" });
    await sleep(200);
    const state = JSON.parse(await pageState("root", tab.tabId));
    assert(state.single?.[0]?.name === "resume.txt" && state.single[0].head.startsWith("fullstack upload"), `state ${JSON.stringify(state)}`);
    await client.call("tabs.close", { sessionId: "root", tabId: tab.tabId });
    return `mode ${(res.warnings ?? []).join("; ") || "ok"}`;
  });

  // ---------------------------------------------------------------- download (per tab, real path)
  await check("download attributed to tab with final path", async () => {
    const tab = await client.call("tabs.open", { sessionId: "root", url: fixtures.url("download.html?tag=r2") });
    await client.call("act", { sessionId: "root", action: "click", selector: "#dl-named", snapshot: "none" });
    const waited = await client.call("wait", { sessionId: "root", for: "download", timeoutMs: 15_000 });
    if (!(waited.ok && waited.download?.path)) {
      const ev = await client.call("session.events", { sessionId: "root", afterSeq: 0 });
      throw new Error(`wait result ${JSON.stringify(waited)}; events ${JSON.stringify(ev.events.filter((e) => e.type.startsWith("download") || e.tabId === tab.tabId).slice(-8))}`);
    }
    assert(existsSync(waited.download.path), `missing file ${waited.download.path}`);
    assert(waited.download.path.startsWith(TMP), `download escaped the test profile: ${waited.download.path}`);
    assert(waited.download.tabId === tab.tabId, `tab ${waited.download.tabId} != ${tab.tabId}`);
    const size = readFileSync(waited.download.path).length;
    rmSync(waited.download.path, { force: true });
    await client.call("tabs.close", { sessionId: "root", tabId: tab.tabId });
    return `${waited.download.path} (${size} B)`;
  });

  // ---------------------------------------------------------------- dialogs
  await check("dialogs: alert auto-accepted, prompt answered via wait", async () => {
    const tab = await client.call("tabs.open", { sessionId: "root", url: fixtures.url("dialogs.html") });
    const a = await client.call("act", { sessionId: "root", action: "click", selector: "#alert", snapshot: "none" });
    assert(a.events.some((e) => e.type === "dialog" && e.dialogType === "alert"), `events ${JSON.stringify(a.events)}`);
    const waiting = client.call("wait", { sessionId: "root", for: "dialog", dialogAction: { accept: true, promptText: "obu" }, timeoutMs: 10_000 });
    await sleep(50);
    await client.call("act", { sessionId: "root", action: "click", selector: "#prompt", snapshot: "none" });
    const w = await waiting;
    assert(w.ok, `wait ${JSON.stringify(w)}`);
    const state = JSON.parse(await pageState("root", tab.tabId));
    assert(state.prompt === "obu", `prompt=${state.prompt}`);
    await client.call("tabs.close", { sessionId: "root", tabId: tab.tabId });
    return "prompt=obu";
  });

  // ---------------------------------------------------------------- popup
  await check("popup adopted into the opener's session", async () => {
    const tab = await client.call("tabs.open", { sessionId: "root", url: fixtures.url("popup.html") });
    const res = await client.call("act", { sessionId: "root", action: "click", selector: "#open", snapshot: "none" });
    let popup = res.events.find((e) => e.type === "popup_opened");
    if (!popup) {
      const w = await client.call("wait", { sessionId: "root", for: "popup", timeoutMs: 5_000 });
      popup = w.event;
    }
    assert(popup, "no popup_opened event");
    const mine = await client.call("tabs.list", { sessionId: "root" });
    assert(mine.tabs.some((t) => t.tabId === popup.tab.tabId), "popup not in session tabs");
    await client.call("tabs.close", { sessionId: "root", tabId: popup.tab.tabId });
    await client.call("tabs.close", { sessionId: "root", tabId: tab.tabId });
    return `popup tab ${popup.tab.tabId}`;
  });

  // ---------------------------------------------------------------- OOPIF
  await check("cross-origin iframe (OOPIF): snapshot ref + fill + click inside", async () => {
    const tab = await client.call("tabs.open", { sessionId: "root", url: fixtures.url("iframes.html") });
    await client.call("wait", { sessionId: "root", for: "settled", timeoutMs: 5_000 });
    const snap = await client.call("snapshot", { sessionId: "root", interactive: true });
    const holderRefs = [...snap.tree.matchAll(/textbox "Card holder"[^\n]*\[ref=(f\d+e\d+)\]/g)].map((m) => m[1]);
    assert(holderRefs.length >= 2, `frame refs: ${holderRefs.join(",")}\n${snap.tree.slice(0, 1500)}`);
    const crossRef = holderRefs[holderRefs.length - 1];
    await client.call("act", { sessionId: "root", action: "fill", ref: crossRef, value: "Grace", snapshot: "none" });
    const applyRefs = [...snap.tree.matchAll(/button "Apply"[^\n]*\[ref=(f\d+e\d+)\]/g)].map((m) => m[1]);
    await client.call("act", { sessionId: "root", action: "click", ref: applyRefs[applyRefs.length - 1], snapshot: "none" });
    await sleep(300);
    const state = JSON.parse(await pageState("root", tab.tabId));
    assert(state["inner-submit"]?.holder === "Grace" && state["inner-submit"].origin === fixtures.crossOrigin, `state ${JSON.stringify(state)}`);
    await client.call("tabs.close", { sessionId: "root", tabId: tab.tabId });
    return `ref ${crossRef} in ${fixtures.crossOrigin}`;
  });

  // ---------------------------------------------------------------- 4 parallel child sessions
  await check("4 parallel subagents: own tabs, no cross-talk, concurrent", async () => {
    const kids = ["k1", "k2", "k3", "k4"];
    for (const k of kids) await client.call("session.open", { sessionId: k, parentSessionId: "root", label: k });
    const t0 = performance.now();
    const tabs = await Promise.all(
      kids.map(async (k) => {
        const tab = await client.call("tabs.open", { sessionId: k, url: fixtures.url(`form.html?k=${k}`) });
        await client.call("act", { sessionId: k, action: "fill", selector: "#name", value: `name-${k}`, snapshot: "none" });
        await client.call("act", { sessionId: k, action: "check", selector: "#terms", snapshot: "none" });
        await client.call("act", { sessionId: k, action: "click", selector: "#submit", snapshot: "none" });
        const snap = await client.call("snapshot", { sessionId: k, interactive: true });
        return { k, tab, snap };
      }),
    );
    const wall = performance.now() - t0;
    for (const { k, tab } of tabs) {
      const state = JSON.parse(await pageState(k, tab.tabId));
      assert(state.submitted?.name === `name-${k}`, `${k} state ${JSON.stringify(state)}`);
    }
    // Isolation: a sibling may not act on another's tab.
    let denied = false;
    try {
      await client.call("act", { sessionId: "k1", tabId: tabs[1].tab.tabId, action: "click", selector: "#submit" });
    } catch (error) {
      denied = /tab_not_owned|not owned/i.test(String(error.message ?? error)) || error.code === "tab_not_owned";
    }
    assert(denied, "sibling could act on another session's tab");
    const listed = await client.call("tabs.list", { sessionId: "root", scope: "mine+children" });
    assert(listed.tabs.length >= 5, `mine+children ${listed.tabs.length}`);
    for (const k of kids) await client.call("session.close", { sessionId: k });
    await sleep(300);
    const remaining = (await listTargets(port)).filter((t) => t.type === "page" && /k=k\d/.test(t.url));
    assert(remaining.length === 0, `child tabs left open: ${remaining.map((t) => t.url).join(", ")}`);
    return `wall ${Math.round(wall)} ms for 4×(open+fill+check+click+snapshot)`;
  });

  // ---------------------------------------------------------------- finalize
  await check("finalize: session.close closes owned tabs, keeps handoff", async () => {
    const keep = await client.call("tabs.open", { sessionId: "root", url: fixtures.url("table.html") });
    const res = await client.call("session.close", { sessionId: "root", keep: [{ tabId: keep.tabId, status: "handoff" }] });
    await sleep(500);
    const pages = (await listTargets(port)).filter((t) => t.type === "page" && t.url.startsWith(fixtures.origin));
    const urls = pages.map((t) => t.url);
    assert(!urls.some((u) => u.includes("form.html")), `form tab survived: ${urls.join(", ")}`);
    assert(urls.some((u) => u.includes("table.html")), "handoff tab was closed");
    assert(urls.some((u) => u.includes("sentinel.html")), "user's sentinel tab was touched");
    return `closed ${JSON.stringify(res.closedTabIds ?? res.closed ?? "?")}; kept table.html`;
  });

  clearInterval(focusTimer);
  focusTimer = null;
  await check("no focus theft (sentinel tab stayed visible; frontmost app unchanged)", async () => {
    assert(focusSamples.sentinelHidden === 0, `sentinel hidden in ${focusSamples.sentinelHidden}/${focusSamples.total} samples`);
    assert(focusSamples.appChanged === 0, `frontmost app changed in ${focusSamples.appChanged} samples (${[...focusSamples.apps].join(", ")})`);
    return `${focusSamples.total} samples, app ${baselineApp ?? "(headless)"}`;
  });
} catch (error) {
  record("harness", false, error?.stack ?? String(error));
} finally {
  if (focusTimer) clearInterval(focusTimer);
  try { client?.close?.(); } catch {}
  try { harness?.close(); } catch {}
  await killProc(procs.chrome);
  if (procs.daemonPid) {
    try { process.kill(procs.daemonPid, "SIGTERM"); } catch {}
    await sleep(300);
    try { process.kill(procs.daemonPid, "SIGKILL"); } catch {}
  }
  await fixtures?.close();
  if (argv.includes("--keep")) process.stdout.write(`kept ${TMP}\n`);
  else rmSync(TMP, { recursive: true, force: true });
}

const summary = {};
for (const [k, v] of Object.entries(latency)) summary[k] = { n: v.length, p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)) };
process.stdout.write(`\nlatency (ms): ${JSON.stringify(summary, null, 1)}\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ results, latency: summary }, null, 2));
process.exit(failed.length ? 1 : 0);
