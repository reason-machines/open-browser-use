#!/usr/bin/env node
// obu-agent entry.
//
//   obu-agent [--profile P] [--socket PATH] [--backend obu|direct] [--cdp-endpoint URL]
//             [--obu-socket PATH] [--state PATH] [--no-auth] [--lease-ttl-ms N] [--sweep-ms N]
//       Run the resident daemon (one per Chrome profile; refuses to start twice).
//   obu-agent mcp --attach [--profile P] [--socket PATH] [--session ID] [--parent ID] [--label L]
//       MCP stdio proxy onto the daemon socket (spawns the daemon if it is not running).
//   obu-agent call <method> [json-params] [--profile P] [--socket PATH]
//       One JSON-RPC call; prints the result as JSON (scripts, bench, debugging).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DirectCdpBackend } from "../cdp/direct.js";
import { ObuHostBackend } from "../cdp/obu-host.js";
import type { BrowserBackend } from "../cdp/backend.js";
import { runMcpProxy } from "../mcp/index.js";
import { ObuAgentClient, serveJsonRpc } from "../server/rpc.js";
import { openStore } from "../store/index.js";
import { Daemon } from "./daemon.js";
import { agentDir, agentSocketPath, agentTokenPath } from "./paths.js";

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}
function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Read or create the per-profile token (0600). */
export function ensureToken(path: string): string {
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token) return token;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Single daemon per profile: a pid lock file next to the socket. */
export function acquireProfileLock(lockPath: string): () => void {
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, "utf8").trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`another obu-agent (pid ${pid}) already serves this profile (${lockPath})`);
    }
  }
  writeFileSync(lockPath, `${process.pid}\n`, { mode: 0o600 });
  return () => {
    try {
      if (Number(readFileSync(lockPath, "utf8").trim()) === process.pid) rmSync(lockPath, { force: true });
    } catch {
      // already gone
    }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runDaemon(argv: string[]): Promise<void> {
  const profile = flag(argv, "profile") ?? "Default";
  const dir = agentDir(profile);
  const socketPath = flag(argv, "socket") ?? agentSocketPath(profile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const releaseLock = acquireProfileLock(flag(argv, "lock") ?? join(dirname(socketPath), "agent.lock"));
  const token = has(argv, "no-auth") ? undefined : ensureToken(flag(argv, "token-file") ?? (flag(argv, "socket") ? join(dirname(socketPath), "agent.token") : agentTokenPath(profile)));

  const backendKind = flag(argv, "backend") ?? (flag(argv, "cdp-endpoint") ? "direct" : "obu");
  const backend: BrowserBackend =
    backendKind === "direct"
      ? new DirectCdpBackend({ endpoint: flag(argv, "cdp-endpoint") ?? "http://127.0.0.1:9222" })
      : new ObuHostBackend({ socketPath: flag(argv, "obu-socket") });
  const store = openStore(flag(argv, "state") ?? join(dir, "state.sqlite"));
  const log = (line: string) => process.stderr.write(`[obu-agent] ${line}\n`);
  const daemon = new Daemon({
    profile,
    backend,
    store,
    artifactRoot: flag(argv, "artifacts") ?? join(dir, "artifacts"),
    leaseTtlMs: flag(argv, "lease-ttl-ms") ? Number(flag(argv, "lease-ttl-ms")) : undefined,
    sweepMs: flag(argv, "sweep-ms") ? Number(flag(argv, "sweep-ms")) : undefined,
    log,
  });
  await daemon.start();
  rmSync(socketPath, { force: true });
  const server = await serveJsonRpc(socketPath, daemon.handlers(), { token });
  chmodSync(socketPath, 0o600);
  log(`listening on ${socketPath} (profile ${profile}, backend ${backend.kind}, store ${store.kind}, auth ${token ? "token" : "off"})`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    rmSync(socketPath, { force: true });
    releaseLock();
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runMcp(argv: string[]): Promise<void> {
  const profile = flag(argv, "profile") ?? "Default";
  const socketPath = flag(argv, "socket") ?? agentSocketPath(profile);
  const tokenPath = flag(argv, "token-file") ?? (flag(argv, "socket") ? join(dirname(socketPath), "agent.token") : agentTokenPath(profile));
  const sessionId = flag(argv, "session") ?? process.env.OBU_SESSION_ID ?? `mcp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const self = fileURLToPath(import.meta.url);
  await runMcpProxy({
    socketPath,
    tokenPath,
    sessionId,
    parentSessionId: flag(argv, "parent") ?? process.env.OBU_PARENT_SESSION_ID,
    label: flag(argv, "label") ?? process.env.OBU_SESSION_LABEL,
    profile,
    spawnDaemon: has(argv, "no-spawn") ? undefined : [self, "--profile", profile, ...(flag(argv, "socket") ? ["--socket", socketPath] : [])],
  });
}

async function runCall(argv: string[]): Promise<void> {
  const [method, json] = argv.filter((arg, index) => !arg.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  if (!method) throw new Error("usage: obu-agent call <method> [json-params]");
  const profile = flag(argv, "profile") ?? "Default";
  const socketPath = flag(argv, "socket") ?? agentSocketPath(profile);
  const tokenPath = flag(argv, "token-file") ?? (flag(argv, "socket") ? join(dirname(socketPath), "agent.token") : agentTokenPath(profile));
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : undefined;
  const client = new ObuAgentClient(socketPath, { token });
  try {
    const result = await client.request(method, json ? JSON.parse(json) : {});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    client.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "mcp") return runMcp(rest);
  if (command === "call") return runCall(rest);
  if (command === "--help" || command === "help") {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((line) => line.startsWith("//")).slice(1, 11).map((line) => line.slice(3)).join("\n") + "\n");
    return;
  }
  return runDaemon(argv);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/obu-agent")) {
  main().catch((error) => {
    process.stderr.write(`obu-agent failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
