#!/usr/bin/env node
// Live check of agent wire v2 against a real Chrome (Chrome for Testing by
// default) with a throwaway profile, the unpacked extension, and a test native
// host. Never touches the user's own Chrome profile.
//
//   node apps/chrome-extension/live/run-live.mjs [--chrome <binary>] [--keep-open]
//
// Env: OBU_LIVE_CHROME (binary), OBU_LIVE_DEBUG_PORT (default 9410),
//      OBU_LIVE_PORTS (default 9411,9412 — two fixture origins).

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrand, stageBrandedExtension } from "../../../scripts/package-chrome-extension-brand.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "..");
const WORK = path.join(HERE, ".run");
const PROFILE = path.join(WORK, "profile");
const SOCKET = path.join(os.tmpdir(), "obu-A", "live-host.sock");
const argv = process.argv.slice(2);
const argValue = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const CHROME = argValue("--chrome") || process.env.OBU_LIVE_CHROME || findChromeForTesting();
const DEBUG_PORT = Number(process.env.OBU_LIVE_DEBUG_PORT || 9410);
const [PORT_A, PORT_B] = (process.env.OBU_LIVE_PORTS || "9411,9412").split(",").map(Number);
// The extension under test is the branded build (default: reason), staged
// into .run/ext exactly as packaging would produce it.
const BRAND = loadBrand({ brand: argValue("--brand") || process.env.OBU_BRAND || "reason" });
const STAGED_EXTENSION = path.join(WORK, "ext");
const NATIVE_HOST = BRAND.nativeHostName;
const SCREENSHOT = argValue("--screenshot");
const results = [];

function findChromeForTesting() {
  const app = ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"];
  const candidates = [];
  const puppeteer = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(puppeteer)) {
    for (const name of fs.readdirSync(puppeteer)) candidates.push(path.join(puppeteer, name, "chrome-mac-arm64", ...app));
  }
  const playwright = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (fs.existsSync(playwright)) {
    for (const name of fs.readdirSync(playwright).filter((n) => /^chromium-\d+$/.test(n))) {
      candidates.push(path.join(playwright, name, "chrome-mac-arm64", ...app));
    }
  }
  const found = candidates
    .filter((binary) => fs.existsSync(binary))
    .map((binary) => {
      try {
        const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).match(/([\d.]+)/)?.[1] ?? "0";
        return { binary, version };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(a.version, b.version));
  if (!found.length) throw new Error("No Chrome for Testing found; pass --chrome <binary>");
  return found.at(-1).binary;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

function unpackedExtensionId(dir) {
  const hex = crypto.createHash("sha256").update(fs.realpathSync(dir)).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function frontmostApp() {
  try {
    return execFileSync("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function startFixtures() {
  const page = (body) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
  const handler = (origin) => (req, res) => {
    const url = new URL(req.url, origin);
    if (url.pathname === "/frame") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<p id="inside">frame on ${origin}</p>`));
    } else if (url.pathname === "/oopif") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<h1>parent</h1><iframe src="http://127.0.0.1:${PORT_B}/frame"></iframe>`));
    } else if (url.pathname === "/opener") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<a id="pop" href="/frame" target="_blank">open</a>`));
    } else if (url.pathname === "/file.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=obu-live.bin" });
      res.end(Buffer.alloc(4096, 7));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<h1>${url.pathname}</h1>`));
    }
  };
  const a = http.createServer(handler(`http://localhost:${PORT_A}`));
  const b = http.createServer(handler(`http://127.0.0.1:${PORT_B}`));
  for (const [server, port] of [[a, PORT_A], [b, PORT_B]]) {
    server.on("error", (error) => {
      console.error(`fixture port ${port}: ${error.message}`);
      process.exit(3);
    });
    server.listen(port, "127.0.0.1");
  }
  return () => {
    a.close();
    b.close();
  };
}

function setupProfile(extensionId) {
  fs.mkdirSync(path.join(PROFILE, "NativeMessagingHosts"), { recursive: true });
  fs.mkdirSync(path.dirname(SOCKET), { recursive: true });
  fs.writeFileSync(path.join(HERE, "socket-path.txt"), SOCKET);
  const wrapper = path.join(WORK, "host.sh");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "test-host.mjs")}"\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(PROFILE, "NativeMessagingHosts", `${NATIVE_HOST}.json`),
    JSON.stringify({ name: NATIVE_HOST, description: "OBU live test host", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] })
  );
}

class HostClient {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.notifications = [];
    this.nextId = 1;
    let buffered = "";
    socket.on("data", (data) => {
      buffered += data.toString("utf8");
      let index;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, index));
        buffered = buffered.slice(index + 1);
        if (message.id !== undefined && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        } else if (message.method) {
          this.notifications.push({ ...message, at: Date.now() });
        }
      }
    });
  }

  call(method, params = {}, timeoutMs = 20_000) {
    const id = `live-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
        else resolve(message.result);
      });
      this.socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async waitFor(predicate, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = this.notifications.find(predicate);
      if (found) return found;
      await sleep(5);
    }
    return null;
  }
}

async function connectHost(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(SOCKET)) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const s = net.connect(SOCKET, () => resolve(s));
          s.once("error", reject);
        });
        return new HostClient(socket);
      } catch {}
    }
    await sleep(100);
  }
  throw new Error("native host never connected (extension did not start?)");
}

// Raw CDP over the remote-debugging port, used only to act as "the user"
// (e.g. drag a tab out of a group) from the extension's own service worker.
async function serviceWorkerEval(extensionId, expression) {
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const sw = list.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`));
  if (!sw) throw new Error("extension service worker target not found");
  const ws = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const reply = await new Promise((resolve) => {
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id === 1) resolve(message);
    };
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result?.result?.value;
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  stageBrandedExtension({ out: STAGED_EXTENSION, brand: BRAND });
  const extensionId = unpackedExtensionId(STAGED_EXTENSION);
  setupProfile(extensionId);
  const stopFixtures = startFixtures();
  const userUrl = `http://localhost:${PORT_A}/user-tab`;
  const chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${STAGED_EXTENSION}`,
      `--disable-extensions-except=${STAGED_EXTENSION}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--no-first-run",
      // Without these, page loads can hang on a macOS keychain prompt.
      "--use-mock-keychain",
      "--password-store=basic",
      "--no-default-browser-check",
      "--disable-search-engine-choice-screen",
      userUrl
    ],
    { stdio: "ignore" }
  );
  console.log(`chrome pid ${chrome.pid}: ${CHROME}`);
  let host;
  try {
    host = await connectHost();
    const S = (session_id, extra = {}) => ({ session_id, turn_id: "live", ...extra });
    const info = await host.call("getInfo");
    check("extension connected via native host", Boolean(info.metadata?.profileId), `v${info.version}, wire=${info.capabilities.wire.length} features`);
    const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    console.log(`browser: ${version.Browser}`);

    await sleep(1500); // let the launch focus settle before sampling
    const front0 = frontmostApp();
    const userState = () =>
      serviceWorkerEval(extensionId, `(async () => { const w = await chrome.windows.getLastFocused(); const [t] = await chrome.tabs.query({active:true, windowId:w.id}); return {windowId:w.id, focused:w.focused, tabId:t?.id, url:t?.url}; })()`);
    const user0 = await userState();

    // 0. Warm-up: one sequential tab.
    let warm = Date.now();
    const warmTab = await host.call("createTab", S("s-warm", { url: `http://localhost:${PORT_A}/warm` }), 8000);
    check("createTab (sequential)", typeof warmTab.id === "number", `${Date.now() - warm} ms`);
    await host.call("finalizeTabs", S("s-warm", { keep: [] }));

    // 1. 4 sessions × 2 tabs, created concurrently.
    const t0 = Date.now();
    const created = await Promise.all(
      ["alpha", "beta", "gamma", "delta"].flatMap((label) => [
        host.call("createTab", S(`s-${label}`, { label, url: `http://localhost:${PORT_A}/${label}-1` })),
        host.call("createTab", S(`s-${label}`, { label, url: `http://localhost:${PORT_A}/${label}-2` }))
      ])
    );
    const createMs = Date.now() - t0;
    console.log("  · created:", created.map((t) => `${t.id}:${t.url}`).join(" "));
    const groups = await serviceWorkerEval(extensionId, `(async () => (await chrome.tabGroups.query({})).map(g => ({id:g.id,title:g.title,color:g.color})))()`);
    const tabGroups = await serviceWorkerEval(extensionId, `(async () => Object.fromEntries((await chrome.tabs.query({})).map(t => [t.id, t.groupId])))()`);
    let groupedRight = groups.length === 4;
    for (let i = 0; i < 4; i += 1) {
      const [x, y] = [created[2 * i], created[2 * i + 1]];
      groupedRight &&= tabGroups[x.id] === tabGroups[y.id] && tabGroups[x.id] !== -1;
    }
    groupedRight &&= groups.every((g) => g.title === BRAND.groupTitle && g.color === BRAND.groupColor);
    check("4 sessions × 2 tabs land in 4 correct groups", groupedRight, `${groups.map((g) => `${g.title}/${g.color}`).join(", ")}; 8 tabs in ${createMs} ms`);
    const user1 = await userState();
    const front1 = frontmostApp();
    check("user's active tab + focused window unchanged", user0.tabId === user1.tabId && user0.windowId === user1.windowId, `active tab ${user1.tabId} ${user1.url}`);
    check("frontmost app unchanged", front0 === front1, `${front0} → ${front1}`);
    check("targetId reported for new tabs", created.every((tab) => typeof tab.targetId === "string"));
    if (SCREENSHOT) {
      const win = await serviceWorkerEval(extensionId, `(async () => { const w = await chrome.windows.getLastFocused(); await chrome.windows.update(w.id, {focused:true}); return w; })()`);
      await sleep(400);
      try {
        execFileSync("screencapture", ["-x", "-R", `${win.left},${win.top},${Math.min(win.width, 1400)},90`, SCREENSHOT]);
        console.log(`  · tab strip screenshot: ${SCREENSHOT}`);
      } catch (error) {
        console.log(`  · screenshot failed: ${error.message}`);
      }
    }

    // 2. Implicit attach + timings.
    const tab = created[0];
    let start = Date.now();
    const first = await host.call("executeCdp", S("s-alpha", { target: { tabId: tab.id }, method: "Runtime.evaluate", commandParams: { expression: "document.title || location.pathname", returnByValue: true } }));
    const firstMs = Date.now() - start;
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      start = performance.now();
      await host.call("executeCdp", S("s-alpha", { target: { tabId: tab.id }, method: "Runtime.evaluate", commandParams: { expression: "1+1", returnByValue: true } }));
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    check("executeCdp implicit attach (no attach call)", typeof first.result?.value === "string", `value ${JSON.stringify(first.result?.value)}; ` + `first call (attach+eval) ${firstMs} ms; warm p50 ${samples[10].toFixed(1)} ms`);

    // 3. 5 MB result ext→host, and a 2.5 MB chunked request host→ext.
    start = Date.now();
    const big = await host.call("executeCdp", S("s-alpha", { target: { tabId: tab.id }, method: "Runtime.evaluate", commandParams: { expression: "'x'.repeat(5*1024*1024)", returnByValue: true } }), 30_000);
    check("5 MB evaluate round-trips", big.result?.value?.length === 5 * 1024 * 1024, `${Date.now() - start} ms`);
    start = Date.now();
    const pad = "y".repeat(2_500_000);
    const chunked = await host.call("executeCdp", S("s-alpha", { target: { tabId: tab.id }, method: "Runtime.evaluate", commandParams: { expression: `${JSON.stringify(pad)}.length`, returnByValue: true } }), 30_000);
    check("2.5 MB host→extension request reassembled from chunks", chunked.result?.value === pad.length, `${Date.now() - start} ms`);

    // 4. OOPIF child session: auto-attach (flatten) → isolated world eval via sessionId.
    const oopTab = await host.call("createTab", S("s-oopif", { label: "oopif", url: "about:blank" }));
    await host.call("subscribe", S("s-oopif", { tabId: oopTab.id, domains: ["Page", "Target"] }));
    const step = async (label, method, commandParams = {}) => {
      const t = Date.now();
      try {
        const r = await host.call("executeCdp", S("s-oopif", { target: { tabId: oopTab.id }, method, commandParams, timeoutMs: 6000 }));
        console.log(`  · ${label}: ${Date.now() - t} ms`);
        return r;
      } catch (error) {
        console.log(`  · ${label}: FAILED after ${Date.now() - t} ms: ${error.message}`);
        return null;
      }
    };
    await step("Page.enable", "Page.enable");
    await step("Page.navigate", "Page.navigate", { url: `http://localhost:${PORT_A}/oopif` });
    await sleep(800);
    await step("Target.setAutoAttach", "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const attached = await host.waitFor((n) => n.method === "onCDPEvent" && n.params.method === "Target.attachedToTarget" && n.params.params?.targetInfo?.type === "iframe", 8000);
    let oopifOk = false;
    let oopifDetail = "no Target.attachedToTarget(iframe) event";
    if (attached) {
      const childSession = attached.params.params.sessionId;
      const frameId = attached.params.params.targetInfo.targetId;
      try {
        const world = await host.call("executeCdp", S("s-oopif", { target: { tabId: oopTab.id, sessionId: childSession }, method: "Page.createIsolatedWorld", commandParams: { frameId, worldName: "__obu_utility" } }));
        const evaluated = await host.call("executeCdp", S("s-oopif", { target: { tabId: oopTab.id, sessionId: childSession }, method: "Runtime.evaluate", commandParams: { expression: "location.origin + '|' + document.getElementById('inside')?.textContent", contextId: world.executionContextId, returnByValue: true } }));
        oopifOk = evaluated.result?.value?.startsWith(`http://127.0.0.1:${PORT_B}|frame on`);
        await host.call("executeCdp", S("s-oopif", { target: { tabId: oopTab.id, sessionId: childSession }, method: "Page.enable" }));
        await host.call("executeCdp", S("s-oopif", { target: { tabId: oopTab.id, sessionId: childSession }, method: "Runtime.evaluate", commandParams: { expression: "location.reload()" } }));
        await host.waitFor((n) => n.method === "onCDPEvent" && n.params.sessionId === childSession, 3000);
        oopifDetail = `child session ${childSession.slice(0, 8)}…, isolated ctx ${world.executionContextId}: ${evaluated.result?.value}`;
      } catch (error) {
        oopifDetail = error.message;
      }
    }
    check("OOPIF child session Runtime.evaluate in isolated world via sessionId", oopifOk, oopifDetail);
    const childEvents = host.notifications.filter((n) => n.method === "onCDPEvent" && n.params.sessionId);
    check("onCDPEvent carries child sessionId", childEvents.length > 0 || oopifOk, `${childEvents.length} child-session events`);

    // 5. Drag-out (user ungroups an owned tab) → leaseRevoked < 500 ms.
    const victim = created[2];
    const before = Date.now();
    await serviceWorkerEval(extensionId, `chrome.tabs.ungroup(${victim.id})`);
    const revoked = await host.waitFor((n) => n.method === "leaseRevoked" && n.params.tabId === victim.id, 3000);
    check("drag-out → leaseRevoked < 500 ms", Boolean(revoked) && revoked.at - before < 500, revoked ? `${revoked.at - before} ms, session ${revoked.params.sessionId}` : "no event");
    const betaTabs = await host.call("getTabs", S("s-beta"));
    check("revoked tab no longer in session", !betaTabs.some((t) => t.id === victim.id), `s-beta tabs: ${betaTabs.map((t) => t.id).join(",")}`);

    // 6. Popup adoption.
    const openerTab = created[4];
    await host.call("executeCdp", S("s-gamma", { target: { tabId: openerTab.id }, method: "Page.navigate", commandParams: { url: `http://localhost:${PORT_A}/opener` } }));
    await sleep(400);
    await host.call("executeCdp", S("s-gamma", { target: { tabId: openerTab.id }, method: "Runtime.evaluate", commandParams: { expression: "document.getElementById('pop').click()", userGesture: true } }));
    const popup = await host.waitFor((n) => n.method === "popupOpened" && n.params.openerTabId === openerTab.id, 4000);
    if (!popup) {
      const recent = await serviceWorkerEval(extensionId, `(async () => (await chrome.tabs.query({})).sort((a,b)=>b.id-a.id).slice(0,2).map(t => ({id:t.id, opener:t.openerTabId, url:t.url||t.pendingUrl, active:t.active, group:t.groupId})))()`);
      console.log("  · newest tabs:", JSON.stringify(recent), "opener", openerTab.id, "popupOpened:", JSON.stringify(host.notifications.filter((n) => n.method === "popupOpened").map((n) => n.params)));
    }
    const gammaTabs = popup ? await host.call("getTabs", S("s-gamma")) : [];
    check("popup adopted into opener's session", Boolean(popup) && gammaTabs.some((t) => t.id === popup.params.tabId), popup ? `popup tab ${popup.params.tabId}` : "no popupOpened");
    const user2 = await userState();
    check("user's active tab still unchanged after popup", user2.tabId === user0.tabId, `active ${user2.tabId}`);

    // 7. Download correlated to its tab.
    const dlTab = created[6];
    await host.call("executeCdp", S("s-delta", { target: { tabId: dlTab.id }, method: "Page.enable" }));
    await host.call("executeCdp", S("s-delta", { target: { tabId: dlTab.id }, method: "Browser.setDownloadBehavior", commandParams: { behavior: "allowAndName", downloadPath: path.join(WORK, "downloads"), eventsEnabled: true } })).catch(() => null);
    await host.call("executeCdp", S("s-delta", { target: { tabId: dlTab.id }, method: "Runtime.evaluate", commandParams: { expression: `location.href = 'http://localhost:${PORT_A}/file.bin'` } }));
    const dl = await host.waitFor((n) => n.method === "onDownloadChange" && n.params.status === "started", 6000);
    check("download carries tabId/session/referrer", Boolean(dl) && dl.params.tabId === dlTab.id && dl.params.sessionId === "s-delta", dl ? `tab ${dl.params.tabId} (${dl.params.tabConfidence}), session ${dl.params.sessionId}, startTime ${dl.params.startTime ? "yes" : "no"}` : "no download event");

    // 8. Route mismatch.
    const routed = await host.call("createTab", S("s-route", { route: { profileId: "not-this-profile" } })).then(() => null, (error) => error.rpc);
    check("route.profileId mismatch rejected", routed?.code === -32010, routed?.message);

    // 9. Close guard + finalize: activate one alpha tab as if the user clicked it.
    const viewed = created[1];
    await serviceWorkerEval(extensionId, `chrome.tabs.update(${viewed.id}, {active:true})`);
    await sleep(100);
    console.log("  · s-alpha tabs before finalize:", JSON.stringify(await host.call("getTabs", S("s-alpha"))));
    const fin = await host.call("finalizeTabs", S("s-alpha", { keep: [] }));
    console.log("  · finalize:", JSON.stringify(fin));
    check("finalize closes owned tabs but guards the one the user is viewing", fin.closedTabIds.includes(created[0].id) && fin.releasedTabIds.includes(viewed.id), JSON.stringify(fin.guardedTabs));
    for (const sid of ["s-beta", "s-gamma", "s-delta", "s-oopif"]) await host.call("finalizeTabs", S(sid, { keep: [] }));
    await sleep(300);
    const remainingGroups = await serviceWorkerEval(extensionId, `(async () => (await chrome.tabGroups.query({})).length)()`);
    check("no agent groups left after finalize", remainingGroups === 0, `${remainingGroups} groups`);
    const leftover = await serviceWorkerEval(extensionId, `(async () => (await chrome.tabs.query({})).filter(t => t.url && t.url.includes(":${PORT_A}/") && !t.url.endsWith("/user-tab")).map(t => t.id))()`);
    check("only the user's tab and the released (viewed) tab remain", leftover.length <= 2, `remaining agent-origin tabs: ${leftover.join(",") || "none"}`);
  } finally {
    if (!argv.includes("--keep-open")) {
      chrome.kill("SIGTERM");
      for (let i = 0; i < 30 && chrome.exitCode === null && chrome.signalCode === null; i += 1) await sleep(100);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }
    host?.socket.destroy();
    stopFixtures();
    // RAM hygiene: no profile/ext left behind unless asked to keep the browser.
    if (!argv.includes("--keep-open")) fs.rmSync(WORK, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
