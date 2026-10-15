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
import { appendFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, writeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    mkdirSync(join(userDataDir, "Default"), { recursive: true });
    writeFileSync(join(userDataDir, "Default", "Preferences"), JSON.stringify({ download: { default_directory: env.downloadsDir, prompt_for_download: false, directory_upgrade: true }, savefile: { default_directory: env.downloadsDir } }));
    const chrome = await launchChrome({ tmp, port: env.cdpPort, userDataDir });
    started.procs.push(chrome.proc);
    dbg("chrome up", chrome.bin, env.cdpPort);
    env.chrome = chrome; env.extensionId = extensionId;
    env.cdp = started.cdp = await Cdp.connect(await browserWsUrl(env.cdpPort));
    // Downloads go to our temp dir via the profile's own preference (set before launch), NOT
    // Browser.setDownloadBehavior: a CDP download override makes Chrome skip its
    // "name (1).ext" uniquifying, so concurrent same-name downloads overwrite each other.
    env.extensionLoaded = await waitForExtension(env);
    dbg("extension loaded", env.extensionLoaded, env.extensionId);
    if (!env.extensionLoaded) env.notes.push(`extension service worker not found (id ${extensionId})`);
    else {
      // PLAN D6 #5: uploads must work with the extension's file-URL access OFF (the default for
      // Web Store installs). --load-extension grants it, so revoke it unless E2E_FILE_URL_ACCESS=on.
      env.fileUrlAccess = await fileAccess(env, process.env.E2E_FILE_URL_ACCESS === "on" ? undefined : false).catch((e) => `unknown (${e.message})`);
    }
    dbg("file-URL access", env.fileUrlAccess);
  }

  const socket = process.env.OBU_AGENT_SOCKET ?? (REAL_PROFILE ? agentSocketPath(process.env.E2E_PROFILE ?? "Default") : join(env.tmp, "agent.sock"));
  env.socket = socket;
  env.ownsDaemon = !process.env.OBU_AGENT_SOCKET && !REAL_PROFILE;
  if (env.ownsDaemon) {
    const why = await spawnDaemon(env);
    if (why) { env.unavailable = why; return env; }
  }
  try {
    env.client = await new ObuAgentClient(socket, { token: agentToken(socket) }).connect();
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

/** The daemon's client token: agent.token next to its socket (0600), absent with --no-auth. */
function agentToken(socket) {
  const path = join(dirname(socket), "agent.token");
  return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
}

async function spawnDaemon(env) {
  const socket = env.socket;
  const cmd = process.env.E2E_DAEMON_CMD
    ? ["/bin/sh", ["-c", process.env.E2E_DAEMON_CMD]]
    : [process.execPath, [join(REPO_ROOT, "packages/obu-agent/dist/daemon/main.js"), "--profile", "e2e", "--socket", socket, "--obu-socket", env.hostSocket, ...(process.env.E2E_LEASE_TTL_MS ? ["--lease-ttl-ms", process.env.E2E_LEASE_TTL_MS] : [])]];
  const daemon = spawn(cmd[0], cmd[1], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, OBU_RELAY_SOCKET: env.hostSocket, OBU_AGENT_SOCKET: socket, OBU_DOWNLOADS_DIR: env.downloadsDir, OBU_BRAND_DIR: `obu-e2e-${process.pid}` } });
  let err = ""; daemon.stderr.on("data", (d) => { err = (err + d).slice(-4000); if (process.env.E2E_DAEMON_LOG) appendFileSync(process.env.E2E_DAEMON_LOG, d); });
  started.procs.push(daemon); env.daemon = daemon; env.daemonStderr = () => err;
  const t = Date.now();
  while (!existsSync(socket) && Date.now() - t < 10_000) {
    if (daemon.exitCode !== null) break;
    await sleep(50);
  }
  return existsSync(socket) ? null : `daemon did not create ${socket}: ${err}`;
}

/** I5 test support: SIGKILL our daemon and start a fresh one on the same socket. */
export async function restartDaemon(env) {
  if (!env.ownsDaemon) throw new Pending("restart needs a harness-owned daemon");
  try { env.client?.close(); } catch {}
  await killProc(env.daemon, "SIGKILL");
  started.procs = started.procs.filter((p) => p !== env.daemon);
  rmSync(env.socket, { force: true });
  const why = await spawnDaemon(env);
  if (why) throw new Error(why);
  env.client = await new ObuAgentClient(env.socket, { token: agentToken(env.socket) }).connect();
  env.info = await env.client.call("daemon.info", {});
  return env.client;
}

/** Read (and optionally set) the extension's "Allow access to file URLs" via chrome://extensions. */
async function fileAccess(env, set) {
  const { targetId } = await env.cdp.send("Target.createTarget", { url: "chrome://extensions/", background: true });
  try {
    await sleep(800);
    const page = await attachPage(env.cdp, targetId);
    const id = JSON.stringify(env.extensionId);
    if (set !== undefined) {
      // Developer mode first: without it CfT re-disables the reloaded command-line extension
      // ("unsupportedDeveloperExtension") when the toggle reloads it.
      await page.evaluate(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }).then(() => true)`);
      await page.evaluate(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${id}, fileAccess: ${set} }).then(() => true)`);
      await sleep(500);
      await page.evaluate(`chrome.management.setEnabled(${id}, true).then(() => true)`);
    }
    const info = await page.evaluate(`chrome.developerPrivate.getExtensionInfo(${id}).then((i) => i.fileAccess)`);
    await page.detach();
    // Toggling file access reloads the extension; its MV3 service worker then stays asleep (no
    // event wakes it) and never reconnects the native host. Wake it by opening its popup page.
    if (set !== undefined) await wakeExtension(env);
    return info?.isActive ?? info;
  } finally { await env.cdp.send("Target.closeTarget", { targetId }).catch(() => {}); }
}

async function wakeExtension(env) {
  await sleep(300);
  if (await waitForExtension(env, 500)) return;
  const { targetId } = await env.cdp.send("Target.createTarget", { url: `chrome-extension://${env.extensionId}/popup.html`, background: true });
  try { if (!(await waitForExtension(env, 5000))) env.notes.push("extension service worker did not wake after file-access toggle"); }
  finally { await sleep(300); await env.cdp.send("Target.closeTarget", { targetId }).catch(() => {}); }
}

async function extensionEval(env, expression) {
  const sw = (await listTargets(env.cdpPort)).find((x) => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${env.extensionId}/`));
  if (!sw) throw new Error("no service worker");
  const page = await attachPage(env.cdp, sw.id);
  try { return await page.evaluate(expression); } finally { await page.detach(); }
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
  // Chrome helpers may still be flushing the profile for a moment after exit: retry.
  if (started.tmp && process.env.E2E_KEEP_TMP !== "1") rmSync(started.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
  const ctx = {
    env, t, get client() { return env.client; },
    url: (file) => env.fixtures.url(file),
    xurl: (file) => `${env.fixtures.crossOrigin}/${file}`,
    /** Open an agent session (closed after the test). */
    async session(label = "e2e", extra = {}) {
      const sessionId = `e2e-${process.pid}-${++sessionCounter}-${label}`.replace(/[^\w-]/g, "_");
      const r = await env.client.call("session.open", { sessionId, label, ...extra });
      cleanups.push(() => env.client.call("session.close", { sessionId }));
      return { sessionId, ...r, call: (method, params = {}) => env.client.call(method, { sessionId, ...params }) };
    },
    /** Ground truth: evaluate in the page (raw CDP in CfT mode, daemon page world otherwise). */
    async fx(tab, expression) {
      if (env.cdp && tab.targetId) {
        const page = await attachPage(env.cdp, tab.targetId);
        try { return await page.evaluate(expression); } finally { await page.detach(); }
      }
      const r = await env.client.call("evaluate", { sessionId: tab.sessionId, tabId: tab.tabId, expression, world: "page", awaitPromise: true });
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
    /** Browser-dependent tests: pending (non-strict) until WS-A/B/C connect the extension. */
    requireExtension() { if (!env.info?.extension?.connected) throw new Pending("daemon reports extension not connected (WS-A/B/C)"); },
    /** Open an owned tab on a fixture page; returns a tab handle usable with fx()/snap()/act(). */
    async open(s, file, extra = {}) {
      const r = await s.call("tabs.open", { url: file.startsWith("http") ? file : ctx.url(file), ...extra });
      return { ...r, sessionId: s.sessionId, s };
    },
    snap(tab, params = {}) { return tab.s.call("snapshot", { tabId: tab.tabId, ...params }); },
    act(tab, params) { return tab.s.call("act", { tabId: tab.tabId, ...params }); },
    /** Raw-CDP: does a page target with this id still exist? (null outside CfT mode) */
    async targetAlive(targetId) { const ts = await ctx.pageTargets(); return ts ? ts.some((x) => x.id === targetId) : null; },
    async waitTargetGone(targetId, timeoutMs = 5000) { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { if ((await ctx.targetAlive(targetId)) === false) return true; await sleep(100); } return false; },
    /** Raw-CDP "user" tab (not owned by any agent session). Closed after the test. */
    async userTab(file, { background = true } = {}) {
      ctx.requireCdp();
      const { targetId } = await env.cdp.send("Target.createTarget", { url: ctx.url(file), background });
      cleanups.push(() => env.cdp.send("Target.closeTarget", { targetId }));
      await sleep(400);
      return { targetId };
    },
  };
  return ctx;
}

/** Assert a daemon call rejects with a typed ObuError code. Returns the error. */
export async function expectCode(promise, code) {
  try { await promise; } catch (error) {
    const got = errorCode(error);
    if (got === "not_implemented") throw error; // -> pending
    if (got !== code) throw new Error(`expected ${code}, got ${got}: ${error.message}`);
    return error;
  }
  throw new Error(`expected ${code}, call succeeded`);
}

/** Percentile helper for latency assertions. */
export function pct(xs, p) { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN; }

/** Find the ref of the first snapshot line matching a regexp, e.g. refOf(tree, /button "Create account"/). */
export function refOf(tree, re) {
  for (const line of tree.split("\n")) if (re.test(line)) { const m = line.match(/\[ref=([\w]+)\]/); if (m) return m[1]; }
  throw new Error(`no ref for ${re} in snapshot:\n${tree.slice(0, 3000)}`);
}
