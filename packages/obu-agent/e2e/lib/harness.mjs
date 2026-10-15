// Shared e2e environment (one per process; e2e/all.test.mjs imports every *.suite.mjs so
// they share one Chrome + daemon and calls teardown() in a top-level after()). Modes:
//   default (cft)      fixtures + Chrome for Testing (throwaway profile, fork extension,
//                      dev native host) + obu-agent daemon we spawn.
//   OBU_AGENT_SOCKET   attach to an already-running daemon (we still serve fixtures and,
//                      unless E2E_REAL_PROFILE=1, launch CfT for ground truth).
//   E2E_REAL_PROFILE=1 the user's Chrome via an owned session on the user's daemon; no CfT,
//                      no raw CDP — ground truth goes through daemon `evaluate` (world 'page').
// Pending policy: a test whose daemon call fails with not_implemented (or, outside strict
// mode, extension_disconnected / daemon unavailable) is reported as TODO, not failure.
// E2E_STRICT=1 turns every pending into a failure — that is the Round-1 merge gate.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObuAgentClient, agentSocketPath } from "../../dist/index.js";
import { startFixtures } from "../../fixtures/server.mjs";
import { Cdp, attachPage, browserWsUrl, listTargets } from "./cdp.mjs";
import { buildHost, freePort, installNativeHost, killProc, launchChrome, unpackedExtensionId, EXTENSION_DIR, REPO_ROOT } from "./chrome.mjs";

export const STRICT = process.env.E2E_STRICT === "1";
export const REAL_PROFILE = process.env.E2E_REAL_PROFILE === "1";
const PENDING_CODES = new Set(["not_implemented"]);
const SOFT_PENDING_CODES = new Set(["extension_disconnected"]);

const dbg = (...a) => { if (process.env.E2E_DEBUG === "1") writeSync(2, `[e2e] ${a.join(" ")}\n`); };
let envPromise = null;
const started = { procs: [], tmp: null, fixtures: null, cdp: null };

export function getEnv() {
  envPromise ??= setup().catch((error) => ({ unavailable: `e2e setup failed: ${error.message}`, error }));
  return envPromise;
}

async function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "obu-e2e-"));
  started.tmp = tmp;
  const env = { tmp, unavailable: null, notes: [], mode: REAL_PROFILE ? "real-profile" : "cft" };
  env.fixtures = started.fixtures = await startFixtures();
  dbg("fixtures", env.fixtures.origin);
  env.downloadsDir = join(tmp, "downloads"); mkdirSync(env.downloadsDir, { recursive: true });

  if (!REAL_PROFILE) {
    env.cdpPort = await freePort();
    env.hostSocket = join(tmp, "host.sock");
    const extensionId = unpackedExtensionId(EXTENSION_DIR);
    const hostBin = buildHost(tmp);
    dbg("host built", hostBin);
    // Native host manifest must exist BEFORE Chrome starts so the extension's first connectNative succeeds.
    const userDataDir = join(tmp, "profile");
    installNativeHost({ userDataDir, hostBin, hostSocket: env.hostSocket, extensionId, tmp });
    const chrome = await launchChrome({ tmp, port: env.cdpPort, userDataDir });
    started.procs.push(chrome.proc);
    dbg("chrome up", chrome.bin, env.cdpPort);
    env.chrome = chrome; env.extensionId = extensionId;
    env.cdp = started.cdp = await Cdp.connect(await browserWsUrl(env.cdpPort));
    // Point downloads at our temp dir (ground truth for per-tab download tests).
    await env.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: env.downloadsDir, eventsEnabled: true }).catch(() => {});
    env.extensionLoaded = await waitForExtension(env);
    dbg("extension loaded", env.extensionLoaded, env.extensionId);
    if (!env.extensionLoaded) env.notes.push(`extension service worker not found (id ${extensionId})`);
  }

  const socket = process.env.OBU_AGENT_SOCKET ?? (REAL_PROFILE ? agentSocketPath(process.env.E2E_PROFILE ?? "Default") : join(env.tmp, "agent.sock"));
  env.socket = socket;
  if (!process.env.OBU_AGENT_SOCKET && !REAL_PROFILE) {
    const cmd = process.env.E2E_DAEMON_CMD
      ? ["/bin/sh", ["-c", process.env.E2E_DAEMON_CMD]]
      : [process.execPath, [join(REPO_ROOT, "packages/obu-agent/dist/daemon/main.js"), "--profile", "e2e", "--socket", socket, "--host-socket", env.hostSocket]];
    const daemon = spawn(cmd[0], cmd[1], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OBU_HOST_SOCKET: env.hostSocket, OBU_AGENT_SOCKET: socket, OBU_DOWNLOADS_DIR: env.downloadsDir } });
    let err = ""; daemon.stderr.on("data", (d) => { err = (err + d).slice(-4000); });
    started.procs.push(daemon); env.daemonStderr = () => err;
    const t = Date.now();
    while (!existsSync(socket) && Date.now() - t < 10_000) {
      if (daemon.exitCode !== null) break;
      await sleep(50);
    }
    if (!existsSync(socket)) { env.unavailable = `daemon did not create ${socket}: ${err}`; return env; }
  }
  try {
    env.client = await new ObuAgentClient(socket).connect();
    env.info = await env.client.call("daemon.info", {});
    dbg("daemon", JSON.stringify(env.info));
  } catch (e) { env.unavailable = `daemon unreachable at ${socket}: ${e.message}`; return env; }
  // Wait (bounded) for the extension to reach the daemon.
  const t = Date.now();
  while (!env.info.extension?.connected && Date.now() - t < Number(process.env.E2E_EXTENSION_WAIT_MS ?? 8000)) {
    await sleep(250);
    env.info = await env.client.call("daemon.info", {}).catch(() => env.info);
  }
  if (!env.info.extension?.connected) env.notes.push("daemon reports extension not connected");
  return env;
}

async function waitForExtension(env, timeoutMs = 8000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const targets = await listTargets(env.cdpPort);
    if (targets.some((x) => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${env.extensionId}/`))) return true;
    await sleep(200);
  }
  return false;
}

let tornDown = false;
/** Idempotent cleanup (user rule: quit every Chrome we start, close every tab, no orphans). */
export async function teardown() {
  if (tornDown) return; tornDown = true;
  dbg("teardown start");
  const env = envPromise ? await envPromise.catch(() => null) : null;
  try { env?.client?.close(); } catch {}
  dbg("client closed");
  // Close any page targets we (or the daemon) left in our throwaway Chrome before quitting it.
  if (started.cdp && env?.cdpPort) {
    const pages = (await listTargets(env.cdpPort).catch(() => [])).filter((x) => x.type === "page");
    await Promise.all(pages.map((x) => started.cdp.send("Target.closeTarget", { targetId: x.id }, undefined, 2000).catch(() => {})));
    dbg("closed pages", pages.length);
    await started.cdp.send("Browser.close", {}, undefined, 2000).catch(() => {});
    dbg("browser.close sent");
  }
  try { started.cdp?.close(); } catch {}
  for (const p of started.procs.reverse()) { await killProc(p); dbg("killed", p.pid, p.exitCode, p.signalCode); }
  started.procs.length = 0;
  await Promise.race([started.fixtures?.close().catch(() => {}), sleep(1000)]);
  if (started.tmp && process.env.E2E_KEEP_TMP !== "1") rmSync(started.tmp, { recursive: true, force: true });
  dbg("teardown done");
}

/** Synchronous last-resort kill on abnormal exit (Ctrl-C, timeout, crash). */
function killSync() { for (const p of started.procs) { try { p.kill("SIGKILL"); } catch {} } }
process.once("exit", killSync);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { teardown().finally(() => process.exit(130)); setTimeout(() => { killSync(); process.exit(130); }, 5000).unref(); });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorCode(error) { return error?.code ?? error?.data?.code; }

export class Pending extends Error { constructor(reason) { super(reason); this.name = "Pending"; } }

/**
 * `e2e(name, fn)` — node:test wrapper with the pending policy. `fn(ctx)` gets
 * { env, client, t, session(label?), fx(target, expr), ... }.
 */
export function pendingAware(test) {
  return function e2e(name, opts, fn) {
    if (typeof opts === "function") { fn = opts; opts = {}; }
    return test(name, { timeout: 90_000, ...opts }, async (t) => {
      const env = await getEnv();
      const cleanups = [];
      t.after(async () => { for (const c of cleanups.reverse()) await c().catch(() => {}); });
      const pend = (reason) => { if (STRICT) throw new Error(`pending in strict mode: ${reason}`); t.todo(`pending: ${reason}`); };
      if (env.unavailable) return pend(env.unavailable);
      try {
        await fn(makeCtx(env, t, cleanups));
      } catch (error) {
        const code = errorCode(error);
        if (error instanceof Pending) return pend(error.message);
        if (PENDING_CODES.has(code)) return pend(`${code}: ${error.message}`);
        if (SOFT_PENDING_CODES.has(code) && !STRICT) return pend(`${code}: ${error.message}`);
        throw error;
      }
    });
  };
}

let sessionCounter = 0;
function makeCtx(env, t, cleanups) {
  const client = env.client;
  const ctx = {
    env, t, client,
    url: (file) => env.fixtures.url(file),
    xurl: (file) => `${env.fixtures.crossOrigin}/${file}`,
    /** Open an agent session (closed after the test). */
    async session(label = "e2e", extra = {}) {
      const sessionId = `e2e-${process.pid}-${++sessionCounter}-${label}`.replace(/[^\w-]/g, "_");
      const r = await client.call("session.open", { sessionId, label, ...extra });
      cleanups.push(() => client.call("session.close", { sessionId }));
      return { sessionId, ...r, call: (method, params = {}) => client.call(method, { sessionId, ...params }) };
    },
    /** Ground truth: evaluate in the page (raw CDP in CfT mode, daemon page world otherwise). */
    async fx(tab, expression) {
      if (env.cdp && tab.targetId) {
        const page = await attachPage(env.cdp, tab.targetId);
        try { return await page.evaluate(expression); } finally { await page.detach(); }
      }
      const r = await client.call("evaluate", { sessionId: tab.sessionId, tabId: tab.tabId, expression, world: "page", awaitPromise: true });
      return r.value;
    },
    /** Poll ground truth until predicate passes (for async page effects, not agent waits). */
    async until(tab, expression, pred = Boolean, timeoutMs = 5000) {
      const t0 = Date.now(); let v;
      while (Date.now() - t0 < timeoutMs) { v = await ctx.fx(tab, expression); if (pred(v)) return v; await sleep(100); }
      throw new Error(`until(${expression}) timed out; last=${JSON.stringify(v)}`);
    },
    /** Page targets currently open in CfT (raw CDP). */
    async pageTargets() { if (!env.cdpPort) return null; return (await listTargets(env.cdpPort)).filter((x) => x.type === "page"); },
    requireCdp() { if (!env.cdp) throw new Pending("needs raw CDP ground truth (CfT mode)"); },
  };
  return ctx;
}

/** Find the ref of the first snapshot line matching a regexp, e.g. refOf(tree, /button "Create account"/). */
export function refOf(tree, re) {
  for (const line of tree.split("\n")) if (re.test(line)) { const m = line.match(/\[ref=([\w]+)\]/); if (m) return m[1]; }
  throw new Error(`no ref for ${re} in snapshot:\n${tree.slice(0, 3000)}`);
}
