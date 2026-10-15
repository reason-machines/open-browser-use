// WS-E live-test harness: Chrome for Testing (throwaway profile) over raw CDP,
// plus a minimal PageContext/TabCdp that mirrors what WS-C provides
// (attach sequence without Runtime.enable, owned-tab metrics override, focus
// emulation, utility-world frames incl. OOPIF child sessions, dialog policy).
// Refs are resolved via `data-ref` attributes in the test pages (WS-D's real
// refs are out of scope here).
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { deliverSystemEvent, takePendingDialogAction } from "../dist/wait/index.js";
import { configureDownloads } from "../dist/files/index.js";

const CANDIDATES = [
  process.env.OBU_CFT,
  join(homedir(), "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
  join(homedir(), ".cache/puppeteer/chrome/mac_arm-151.0.7922.77/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree(port) {
  try {
    execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { stdio: "pipe" });
    return false;
  } catch {
    return true;
  }
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ""}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg.method, msg.params, msg.sessionId);
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: CDP timeout after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify(msg));
    });
  }
  onAny(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export async function launchChrome({ headful = process.env.OBU_E2E_HEADFUL === "1" } = {}) {
  const bin = findChrome();
  if (!bin) return null;
  let port = 9450;
  while (port <= 9459 && !portFree(port)) port++;
  if (port > 9459) throw new Error("no free port in 9450-9459");
  const userDataDir = mkdtempSync(join(tmpdir(), "obu-wse-profile-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Without these, page loads can hang on a macOS keychain prompt.
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-features=Translate,MediaRouter",
    "--window-size=1440,900",
    "about:blank",
  ];
  let child = null;
  let pid = null;
  if (headful) {
    // `open -g` launches without bringing CfT to the front (no focus theft on the user's desktop).
    const app = bin.replace(/\/Contents\/MacOS\/.*$/, "");
    execFileSync("open", ["-g", "-n", "-a", app, "--args", ...args]);
  } else {
    child = spawn(bin, ["--headless=new", ...args], { stdio: "ignore" });
    pid = child.pid;
  }
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch {
      await sleep(100);
    }
  }
  if (!wsUrl) throw new Error("Chrome for Testing did not start");
  if (headful) {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).toString().trim().split("\n")[0];
    pid = Number(out);
  }
  // Never leave an orphan Chrome (user rule: Mac RAM): kill on any exit path.
  const kill = () => { try { if (pid) process.kill(pid, "SIGKILL"); } catch { /* gone */ } };
  process.once("exit", kill);
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { kill(); process.exit(130); });
  const cdp = await Cdp.connect(wsUrl);
  const downloadDir = mkdtempSync(join(tmpdir(), "obu-wse-downloads-"));
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloadDir, eventsEnabled: true });
  configureDownloads({ downloadDir, naming: "guid" });
  return new Browser(cdp, { pid, child, userDataDir, downloadDir, headful, port });
}

let nextTabId = 1000;

export class Browser {
  constructor(cdp, info) {
    this.cdp = cdp;
    this.info = info;
    this.tabs = [];
  }

  /** Open a tab. Owned agent tabs are background; `foreground` simulates the user's own tab. */
  async openTab(url, { foreground = false, owned = true, bare = false } = {}) {
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank", background: !foreground });
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(this, targetId, sessionId, owned);
    await tab.attach({ bare });
    this.tabs.push(tab);
    if (url) await tab.goto(url);
    return tab;
  }

  async activate(tab) {
    await this.cdp.send("Target.activateTarget", { targetId: tab.targetId });
  }

  async close() {
    for (const t of [...this.tabs]) await t.close();
    this.cdp.close();
    const { pid, child, userDataDir, downloadDir } = this.info;
    if (child) child.kill("SIGTERM");
    else if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    for (let i = 0; i < 50; i++) {
      try { process.kill(pid, 0); await sleep(100); } catch { break; }
    }
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

export class Tab {
  constructor(browser, targetId, sessionId, owned) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId;
    this.owned = owned;
    this.tabId = nextTabId++;
    this.children = new Map(); // child sessionId -> targetId
    this.events = [];
    this.worlds = new Map(); // `${sessionId}|${frameId}|${loaderId}` -> contextId
    this.interceptSend = null; // test hook: (method, params) => undefined | Promise (override)
    this.artifactDir = mkdtempSync(join(tmpdir(), "obu-wse-artifacts-"));
    const self = this;
    this.cdpFacade = {
      tabId: this.tabId,
      targetId,
      send(method, params = {}, opts = {}) {
        if (self.interceptSend) {
          const r = self.interceptSend(method, params, opts);
          if (r) return r;
        }
        return browser.cdp.send(method, params, opts.sessionId ?? self.sessionId, opts.timeoutMs ?? 30000);
      },
      on(event, handler) {
        return browser.cdp.onAny((method, params, sid) => {
          if (method !== event) return;
          if (sid === self.sessionId) handler(params, undefined);
          else if (sid && self.children.has(sid)) handler(params, sid);
        });
      },
    };
  }

  /** `bare`: skip lifecycle/focus emulation (a truly hidden background tab). */
  async attach({ bare = false } = {}) {
    const c = this.browser.cdp;
    const s = this.sessionId;
    c.onAny((method, params, sid) => {
      if (sid === s && method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
        const child = params.sessionId;
        this.children.set(child, params.targetInfo.targetId);
        void (async () => {
          await c.send("Page.enable", {}, child).catch(() => {});
          await c.send("Network.enable", {}, child).catch(() => {});
          await c.send("Page.setLifecycleEventsEnabled", { enabled: false }, child).catch(() => {});
          await c.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
        })();
      }
      if (sid === s && method === "Target.detachedFromTarget") this.children.delete(params.sessionId);
      if (sid === s && method === "Page.javascriptDialogOpening") {
        const pending = takePendingDialogAction(this.cdpFacade);
        const accept = pending ? pending.accept : params.type !== "prompt";
        void c.send("Page.handleJavaScriptDialog", { accept, promptText: pending?.promptText }, s).catch(() => {});
        const ev = { seq: this.events.length + 1, at: Date.now(), sessionId: "test", tabId: this.tabId, type: "dialog", dialogType: params.type, message: params.message, action: accept ? "accepted" : "dismissed" };
        this.events.push(ev);
        deliverSystemEvent(this.cdpFacade, ev);
      }
    });
    await c.send("Page.enable", {}, s);
    await c.send("DOM.enable", {}, s);
    await c.send("Network.enable", {}, s);
    if (!bare) await c.send("Page.setWebLifecycleState", { state: "active" }, s).catch(() => {});
    await c.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, s);
    if (this.owned) await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false }, s);
    if (!bare) await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, s);
  }

  async close() {
    await this.browser.cdp.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
    rmSync(this.artifactDir, { recursive: true, force: true });
    this.browser.tabs = this.browser.tabs.filter((t) => t !== this);
  }

  async goto(url) {
    const loaded = new Promise((r) => {
      const off = this.browser.cdp.onAny((m, _p, sid) => { if (sid === this.sessionId && m === "Page.loadEventFired") { off(); r(); } });
    });
    await this.browser.cdp.send("Page.navigate", { url }, this.sessionId);
    await Promise.race([loaded, sleep(10000)]);
    await sleep(50);
  }

  async worldFor(sessionId, frameId, loaderId) {
    const key = `${sessionId}|${frameId}|${loaderId}`;
    let id = this.worlds.get(key);
    if (!id) {
      const r = await this.browser.cdp.send("Page.createIsolatedWorld", { frameId, worldName: "__obu_utility" }, sessionId);
      id = r.executionContextId;
      this.worlds.set(key, id);
    }
    return id;
  }

  /** FrameHandle[]: main frame + same-process descendants, then OOPIF roots (one level). */
  async frames() {
    const out = [];
    const walk = async (sessionId, node, isChildSession) => {
      const f = node.frame;
      const ctx = await this.worldFor(sessionId, f.id, f.loaderId);
      out.push({ ordinal: out.length, frameId: f.id, sessionId: isChildSession ? sessionId : undefined, utilityContextId: ctx, origin: f.securityOrigin ?? "" });
      for (const c of node.childFrames ?? []) await walk(sessionId, c, isChildSession);
    };
    const { frameTree } = await this.browser.cdp.send("Page.getFrameTree", {}, this.sessionId);
    await walk(this.sessionId, frameTree, false);
    for (const [child] of this.children) {
      try {
        const r = await this.browser.cdp.send("Page.getFrameTree", {}, child);
        await walk(child, r.frameTree, true);
      } catch { /* detaching */ }
    }
    return out;
  }

  page() {
    const self = this;
    return {
      sessionId: "test",
      cdp: this.cdpFacade,
      frames: () => self.frames(),
      async callInjected() {
        throw new Error("__obu not installed in the WS-E harness");
      },
      async resolveRef(ref) {
        const m = /^(?:f(\d+))?(e\d+)$/.exec(ref);
        if (!m) return null;
        const frames = await self.frames();
        const order = m[1] ? [frames[Number(m[1])]].filter(Boolean) : frames;
        for (const frame of order) {
          const r = await self.browser.cdp.send("Runtime.evaluate", {
            expression: `(() => { const q = (root) => { const hit = root.querySelector('[data-ref="${m[2]}"]'); if (hit) return hit; for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const h = q(el.shadowRoot); if (h) return h; } return null; }; return q(document); })()`,
            contextId: frame.utilityContextId,
          }, frame.sessionId ?? self.sessionId).catch(() => null);
          if (r && r.result.objectId && r.result.subtype !== "null") return { frame, objectId: r.result.objectId };
        }
        return null;
      },
      emit(e) {
        const ev = { seq: self.events.length + 1, at: Date.now(), sessionId: "test", ...e };
        self.events.push(ev);
        deliverSystemEvent(self.cdpFacade, ev);
      },
      artifactDir: this.artifactDir,
    };
  }

  /** Evaluate in the page's main world (test assertions only). */
  async eval(expression) {
    const r = await this.browser.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

/** Tiny fixture server for WS-E pages (two origins so cross-origin iframes become OOPIFs). */
export async function startPages(routes, { port = 47250, port2 = 47251 } = {}) {
  const handler = async (req, res) => {
    const url = new URL(req.url, "http://x");
    const r = routes[url.pathname];
    if (!r) { res.writeHead(404); res.end("nf"); return; }
    const v = typeof r === "function" ? await r(url, req) : r;
    if (typeof v === "string") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(v); return; }
    res.writeHead(v.status ?? 200, v.headers ?? {});
    res.end(v.body);
  };
  const listen = (p, host) => new Promise((resolve, reject) => {
    const s = createServer(handler);
    s.once("error", reject);
    s.listen(p, host, () => resolve(s));
  });
  const a = await listen(portFree(port) ? port : 0, "localhost");
  const b = await listen(portFree(port2) ? port2 : 0, "127.0.0.1");
  return {
    origin: `http://localhost:${a.address().port}`,
    crossOrigin: `http://127.0.0.1:${b.address().port}`,
    close: () => Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]),
  };
}

export function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
