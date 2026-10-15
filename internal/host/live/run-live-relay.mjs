#!/usr/bin/env node
// Live check of the REAL Go native host (relay) against the real extension in
// Chrome for Testing with a throwaway profile: auth handshake, chunking in
// both directions, event routing, and the Rust-gate latency measurement.
// Never touches the user's Chrome, native-host manifests or sockets.
//
//   node internal/host/live/run-live-relay.mjs [--chrome <binary>] [--headful]
//
// Ports: debug 9490, fixture 9491 (r2-sdk range 9490-9499).
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrand, stageBrandedExtension } from "../../../scripts/package-chrome-extension-brand.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const WORK = fs.mkdtempSync(path.join("/tmp", "obu-r2-"));
const PROFILE = path.join(WORK, "profile");
const SOCKET_DIR = path.join(WORK, "sock");
const STAGED = path.join(WORK, "ext");
const DEBUG_PORT = 9490;
const FIXTURE_PORT = 9491;
const argv = process.argv.slice(2);
const argValue = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const BRAND = loadBrand({ brand: argValue("--brand") || "reason" });

function findChrome() {
  const app = ["Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"];
  const dirs = [];
  const pw = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (fs.existsSync(pw)) for (const n of fs.readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n))) dirs.push(path.join(pw, n, "chrome-mac-arm64", ...app));
  const pp = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(pp)) for (const n of fs.readdirSync(pp)) dirs.push(path.join(pp, n, "chrome-mac-arm64", ...app));
  const found = dirs.filter((b) => fs.existsSync(b)).sort();
  if (!found.length) throw new Error("no Chrome for Testing; pass --chrome");
  return found.at(-1);
}

function unpackedExtensionId(dir) {
  const hex = crypto.createHash("sha256").update(fs.realpathSync(dir)).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const CHROME = argValue("--chrome") || process.env.OBU_LIVE_CHROME || findChrome();
let chrome;
let fixtures;
function cleanup() {
  if (chrome && chrome.exitCode === null) {
    try {
      process.kill(chrome.pid, "SIGTERM");
    } catch {}
    // Wait (synchronously) up to 5 s for Chrome and its native host to exit.
    for (let i = 0; i < 50 && isAlive(chrome.pid); i += 1) execFileSync("sleep", ["0.1"]);
    if (isAlive(chrome.pid)) {
      try {
        process.kill(chrome.pid, "SIGKILL");
      } catch {}
    }
  }
  fixtures?.close();
  fs.rmSync(WORK, { recursive: true, force: true });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

try {
  const hostBin = path.join(WORK, "obu-host");
  execFileSync("go", ["build", "-o", hostBin, "./cmd/open-browser-use"], { cwd: ROOT, stdio: "inherit" });
  stageBrandedExtension({ out: STAGED, brand: BRAND });
  const extensionId = unpackedExtensionId(STAGED);
  fs.mkdirSync(path.join(PROFILE, "NativeMessagingHosts"), { recursive: true });
  fs.mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o700 });
  const wrapper = path.join(WORK, "host.sh");
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexport OBU_SOCKET_DIR="${SOCKET_DIR}"\nexport OBU_AGENT=off\nexec "${hostBin}" "$@" 2>>"${path.join(WORK, "host.log")}"\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(PROFILE, "NativeMessagingHosts", `${BRAND.nativeHostName}.json`),
    JSON.stringify({ name: BRAND.nativeHostName, description: "r2 live relay", path: wrapper, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] })
  );
  fixtures = http
    .createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><meta charset="utf-8"><button id="b" style="position:fixed;left:10px;top:10px;width:200px;height:80px" onclick="window.clicks=(window.clicks||0)+1">b</button>`);
    })
    .listen(FIXTURE_PORT, "127.0.0.1");
  chrome = spawn(
    CHROME,
    [
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${STAGED}`,
      `--disable-extensions-except=${STAGED}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--remote-debugging-port=${DEBUG_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      "--disable-search-engine-choice-screen",
      ...(argv.includes("--headful") ? [] : ["--headless=new"]),
      "about:blank"
    ],
    { stdio: "ignore" }
  );
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(path.join(SOCKET_DIR, "active.json"))) {
    if (Date.now() > deadline) throw new Error(`host never started; log:\n${fs.existsSync(path.join(WORK, "host.log")) ? fs.readFileSync(path.join(WORK, "host.log"), "utf8") : "(none)"}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const env = {
    ...process.env,
    OBU_LIVE_SOCKET_DIR: SOCKET_DIR,
    OBU_LIVE_CHUNKED_REQUEST: "1",
    OBU_LIVE_GATE: "1",
    OBU_LIVE_FIXTURE: `http://127.0.0.1:${FIXTURE_PORT}/`
  };
  // Async children: the fixture server lives in this process's event loop.
  const run = (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: ROOT, env, stdio: "inherit", ...opts });
      child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
    });
  await run("go", ["test", "./internal/host", "-run", "TestLive", "-count=1", "-v", "-timeout", "600s"]);
  // SDKs against the real token relay.
  await run(process.execPath, [path.join(HERE, "sdk-smoke.mjs")]);
  await run("python3", [path.join(HERE, "sdk_smoke.py")], {
    cwd: path.join(ROOT, "packages/open-browser-use-python"),
    env: { ...env, PYTHONPATH: path.join(ROOT, "packages/open-browser-use-python") }
  });
  console.log("LIVE RELAY: all checks passed");
} finally {
  cleanup();
}
