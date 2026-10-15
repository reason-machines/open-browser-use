#!/usr/bin/env node
// obu-agent entry. WS-C fills in: host connection, store, leases, reconcile, MCP subcommand.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createHandlers, serveJsonRpc } from "../server/index.js";
import { agentSocketPath } from "./paths.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export async function main(): Promise<void> {
  const profile = flag("profile") ?? "Default";
  const socketPath = flag("socket") ?? agentSocketPath(profile);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const server = await serveJsonRpc(socketPath, createHandlers({ profile, startedAt: Date.now() }));
  chmodSync(socketPath, 0o600);
  process.stderr.write(`obu-agent listening on ${socketPath}\n`);
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`obu-agent failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
