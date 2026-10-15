// Live test harness for the snapshot engine (WS-D).
//
// Launches Chrome for Testing headless with a throwaway profile on a port in
// 9440-9449, connects over the browser CDP websocket with flat sessions, and
// implements a minimal `PageContext` (the WS-C seam) so `takeSnapshot` runs
// exactly as it will in the daemon: isolated world per frame, OOPIF child
// sessions via Target.setAutoAttach, no Runtime.enable.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTED_BUNDLE_SOURCE } from "../../dist/injected/index.js";

export const PAGES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "pages");
const WORLD = "__obu_utility";

export function findChrome() {
  if (process.env.OBU_CHROME && existsSync(process.env.OBU_CHROME)) return process.env.OBU_CHROME;
  const base = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac", "chrome-mac-x64"]) {
        const p = join(base, d, sub, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
        if (existsSync(p)) return p;
      }
      const linux = join(base, d, "chrome-linux/chrome");
      if (existsSync(linux)) return linux;
    }
  }
  return null;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

async function pickPort(lo, hi) {
  for (let p = lo; p <= hi; p++) if (await portFree(p)) return p;
  throw new Error(`no free port in ${lo}-${hi}`);
}

/** Static server on two ports → two sites (localhost vs 127.0.0.1) so cross-origin iframes are OOPIFs. */
export async function startServer() {
  const handler = async (req, res) => {
    const u = new URL(req.url, "http://x");
    const file = join(PAGES_DIR, u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, ""));
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  };
  // Two consecutive free ports (iframes.html points at port+1).
  for (let p = 47210; p < 47300; p += 2) {
    if (!(await portFree(p)) || !(await portFree(p + 1))) continue;
    const a = createServer(handler);
    const b = createServer(handler);
    await new Promise((r) => a.listen(p, "127.0.0.1", r));
    await new Promise((r) => b.listen(p + 1, "127.0.0.1", r));
    return { port: p, base: `http://localhost:${p}`, close: () => { a.close(); b.close(); } };
  }
  throw new Error("no free server port pair");
}

class CdpConnection {
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
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 10_000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

export async function launchChrome() {
  const chrome = findChrome();
  if (!chrome) return null;
  const [lo, hi] = (process.env.OBU_TEST_CDP_PORTS ?? "9440-9449").split("-").map(Number);
  const port = await pickPort(lo, hi);
  const userDataDir = mkdtempSync(join(tmpdir(), "obu-snap-"));
  const proc = spawn(chrome, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    "--no-first-run", "--no-default-browser-check", "--site-per-process", "--disable-gpu",
    "--window-size=1440,900", "--use-mock-keychain", "--password-store=basic", "about:blank",
  ], { stdio: "ignore" });
  let wsUrl;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) { proc.kill("SIGKILL"); throw new Error("chrome did not start"); }
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  const conn = new CdpConnection(ws);
  return {
    conn,
    async close() {
      try { ws.close(); } catch {}
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode === null) proc.kill("SIGKILL");
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    },
    newPage: (url) => newPage(conn, url),
  };
}

async function newPage(conn, url) {
  const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true });
  const childSessions = new Set();
  const handlers = new Map();
  conn.listeners.add((msg) => {
    if (msg.method === "Target.attachedToTarget" && (msg.sessionId === sessionId || childSessions.has(msg.sessionId))) {
      const child = msg.params.sessionId;
      if (msg.params.targetInfo.type === "iframe") {
        childSessions.add(child);
        conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, child).catch(() => {});
        conn.send("Page.enable", {}, child).catch(() => {});
      }
    }
    if (msg.method === "Target.detachedFromTarget") childSessions.delete(msg.params.sessionId);
    const hs = handlers.get(msg.method);
    if (hs && (msg.sessionId === sessionId || childSessions.has(msg.sessionId))) for (const h of hs) h(msg.params, msg.sessionId === sessionId ? undefined : msg.sessionId);
  });
  // Attach sequence (subset of A3) — deliberately no Runtime.enable.
  await conn.send("Page.enable", {}, sessionId);
  await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  if (!process.env.OBU_NO_PRELOAD) await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECTED_BUNDLE_SOURCE, worldName: WORLD, runImmediately: true }, sessionId);

  const cdp = {
    tabId: 1,
    targetId,
    send: (method, params, opts = {}) => conn.send(method, params ?? {}, opts.sessionId ?? sessionId, opts.timeoutMs ?? 10_000),
    on(event, h) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(h);
      return () => handlers.get(event).delete(h);
    },
  };

  const worlds = new Map(); // `${session}|${frameId}` -> contextId
  const ordinals = new Map(); // frameId -> ordinal
  let nextOrdinal = 1;

  async function worldFor(sess, frameId, fresh) {
    const key = `${sess ?? ""}|${frameId}`;
    if (!fresh && worlds.has(key)) return worlds.get(key);
    const { executionContextId } = await conn.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: true }, sess ?? sessionId);
    await conn.send("Runtime.evaluate", { expression: INJECTED_BUNDLE_SOURCE, contextId: executionContextId, returnByValue: true }, sess ?? sessionId);
    worlds.set(key, executionContextId);
    return executionContextId;
  }

  function flatten(tree, out = []) {
    out.push(tree.frame);
    for (const c of tree.childFrames ?? []) flatten(c, out);
    return out;
  }

  const page = {
    sessionId: "test-session",
    cdp,
    artifactDir: tmpdir(),
    previousTree: undefined,
    async frames() {
      const result = [];
      const childFrameIds = new Map(); // frameId -> session
      const childTrees = await Promise.all([...childSessions].map(async (s) => {
        try { return { s, tree: (await conn.send("Page.getFrameTree", {}, s)).frameTree }; } catch { return null; }
      }));
      for (const ct of childTrees.filter(Boolean)) for (const f of flatten(ct.tree)) childFrameIds.set(f.id, ct.s);
      const mainTree = (await conn.send("Page.getFrameTree", {}, sessionId)).frameTree;
      const all = [];
      const seen = new Set();
      const walk = (tree) => {
        const f = tree.frame;
        if (!seen.has(f.id)) {
          seen.add(f.id);
          all.push({ frame: f, session: childFrameIds.get(f.id) });
        }
        for (const c of tree.childFrames ?? []) walk(c);
      };
      walk(mainTree);
      for (const ct of childTrees.filter(Boolean)) walk(ct.tree);
      for (const { frame, session } of all) {
        let ordinal = frame.parentId ? ordinals.get(frame.id) : 0;
        if (ordinal === undefined) { ordinal = nextOrdinal++; ordinals.set(frame.id, ordinal); }
        let origin = "";
        try { origin = new URL(frame.url).origin; } catch {}
        try {
          const utilityContextId = await worldFor(session, frame.id, false);
          result.push({ ordinal, frameId: frame.id, sessionId: session, utilityContextId, origin });
        } catch { /* frame not ready */ }
      }
      return result.sort((a, b) => a.ordinal - b.ordinal);
    },
    async callInjected(frame, method, args) {
      const call = async (contextId) => conn.send("Runtime.callFunctionOn", {
        functionDeclaration: "function(m, a){ return globalThis.__obu[m](...a); }",
        executionContextId: contextId,
        arguments: [{ value: method }, { value: args }],
        returnByValue: true,
        awaitPromise: true,
      }, frame.sessionId ?? sessionId);
      let r;
      try {
        r = await call(frame.utilityContextId);
      } catch (e) {
        // Context gone (navigation): recreate world once.
        const ctx = await worldFor(frame.sessionId, frame.frameId, true);
        frame.utilityContextId = ctx;
        r = await call(ctx);
      }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async resolveRef() { return null; },
    emit() {},
  };

  async function goto(u) {
    const loaded = new Promise((resolve) => {
      const off = cdp.on("Page.loadEventFired", () => { off(); resolve(); });
    });
    await conn.send("Page.navigate", { url: u }, sessionId);
    await loaded;
    worlds.clear();
    page.previousTree = undefined;
    // Let OOPIFs attach + load.
    await new Promise((r) => setTimeout(r, 300));
  }
  async function evaluate(expression) {
    const r = await conn.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    return r.result.value;
  }
  async function close() {
    await conn.send("Target.closeTarget", { targetId }).catch(() => {});
  }
  if (url) await goto(url);
  return { page, goto, evaluate, close, sessionId, conn };
}
