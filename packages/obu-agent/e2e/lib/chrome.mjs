// Launch Chrome for Testing (headful by default) with a throwaway profile, the fork's
// unpacked extension and a dev native host whose relay socket lives in our temp dir.
// Never touches the user's Chrome or the user's NativeMessagingHosts dir.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

export const REPO_ROOT = resolve(new URL("../../../../", import.meta.url).pathname);
export const EXTENSION_DIR = join(REPO_ROOT, "apps/chrome-extension");
export const NATIVE_HOST_NAME = process.env.OBU_NATIVE_HOST_NAME ?? "com.ifuryst.open_browser_use.extension";
export const PORT_RANGE = [9460, 9469];

/** Chrome's id for an unpacked extension without a manifest "key": sha256(abs path) -> a..p. */
export function unpackedExtensionId(dir) {
  const hex = createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export function findChromeForTesting() {
  if (process.env.E2E_CHROME) return process.env.E2E_CHROME;
  const roots = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/puppeteer/chrome")];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      const app = [join(root, d, "chrome-mac-arm64/Google Chrome for Testing.app"), join(root, d, "chrome-mac-x64/Google Chrome for Testing.app")]
        .map((a) => join(a, "Contents/MacOS/Google Chrome for Testing")).find(existsSync);
      if (app) found.push({ app, rank: Number((d.match(/(\d+)/) ?? [0, 0])[1]) });
    }
  }
  // Highest playwright revision / puppeteer major wins. Branded Chrome >= 137 ignores --load-extension, so CfT only.
  found.sort((a, b) => b.rank - a.rank);
  if (!found.length) throw new Error("Chrome for Testing not found: set E2E_CHROME or `npx playwright install chromium`");
  return found[0].app;
}

export async function freePort([lo, hi] = PORT_RANGE) {
  for (let p = lo; p <= hi; p++) {
    const ok = await new Promise((r) => { const s = createServer(); s.once("error", () => r(false)); s.listen(p, "127.0.0.1", () => s.close(() => r(true))); });
    if (ok) return p;
  }
  throw new Error(`no free port in ${lo}-${hi}`);
}

/** Build the Go host once per run into tmp (or use OBU_HOST_BIN). */
export function buildHost(tmp) {
  if (process.env.OBU_HOST_BIN) return process.env.OBU_HOST_BIN;
  const out = join(tmp, "open-browser-use-host");
  execFileSync("go", ["build", "-o", out, "./cmd/open-browser-use"], { cwd: REPO_ROOT, stdio: "inherit" });
  return out;
}

/**
 * Install the dev native host into <userDataDir>/NativeMessagingHosts (Chrome on macOS reads
 * the user-data-dir's own NativeMessagingHosts for custom --user-data-dir profiles).
 * The wrapper pins the relay socket to hostSocket so it can't collide with the user's host.
 */
export function installNativeHost({ userDataDir, hostBin, hostSocket, extensionId, tmp }) {
  const wrapper = join(tmp, "native-host.sh");
  writeFileSync(wrapper, `#!/bin/sh\n# e2e dev native host (Chrome passes the caller origin as an arg; ignored)\necho "$(date +%s) launched $*" >> "${join(tmp, "native-host.log")}"\n# --socket-dir pins active.json + relay.token next to our socket (never the user's /tmp/open-browser-use);\n# OBU_AGENT=off: the harness runs its own daemon.\nOBU_AGENT=off exec "${hostBin}" host --socket-dir "${dirname(hostSocket)}" --socket-path "${hostSocket}" 2>> "${join(tmp, "native-host.log")}"\n`);
  chmodSync(wrapper, 0o755);
  const dir = join(userDataDir, "NativeMessagingHosts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${NATIVE_HOST_NAME}.json`), JSON.stringify({
    name: NATIVE_HOST_NAME, description: "obu e2e dev host", type: "stdio", path: wrapper,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2));
  return wrapper;
}

export async function launchChrome({ tmp, port, userDataDir = join(tmp, "profile"), headless = process.env.E2E_HEADLESS === "1", extensionDir = EXTENSION_DIR, startUrl = "about:blank" }) {
  const bin = findChromeForTesting();
  mkdirSync(userDataDir, { recursive: true });
  const args = [
    `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`,
    `--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-features=DialMediaRouteProvider,Translate",
    "--password-store=basic", "--use-mock-keychain", "--window-size=1280,860",
    ...(headless ? ["--headless=new"] : []), startUrl,
  ];
  const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], detached: false });
  let stderr = ""; proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Chrome exited (${proc.exitCode}): ${stderr}`);
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return { proc, bin, userDataDir, stderr: () => stderr }; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill("SIGTERM");
  throw new Error(`Chrome did not expose CDP on ${port}: ${stderr}`);
}

export async function killProc(proc, signal = "SIGTERM", graceMs = 3000) {
  if (!proc || proc.exitCode !== null || proc.signalCode) return;
  proc.kill(signal);
  const t = Date.now();
  while (proc.exitCode === null && !proc.signalCode && Date.now() - t < graceMs) await new Promise((r) => setTimeout(r, 50));
  if (proc.exitCode === null && !proc.signalCode) proc.kill("SIGKILL");
}
