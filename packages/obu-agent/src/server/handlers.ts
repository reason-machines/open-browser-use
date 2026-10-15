// WS-C: scaffold handler table (no browser): daemon.info works, everything else is not_implemented.
// The real table is Daemon.handlers() (src/daemon/daemon.ts).
import { CONTRACT_VERSION, METHODS, type DaemonInfoResult, type MethodName } from "../contract.js";
import { notImplemented } from "../errors.js";
import type { HandlerTable } from "./rpc.js";

export { DAEMON_VERSION } from "../daemon/daemon.js";
import { DAEMON_VERSION } from "../daemon/daemon.js";

const OWNERS: Partial<Record<MethodName, string>> = {
  snapshot: "WS-D",
  act: "WS-E",
  screenshot: "WS-E",
  wait: "WS-E",
};

export interface HandlerDeps {
  profile: string;
  startedAt: number;
}

export function createHandlers(deps: HandlerDeps): HandlerTable {
  const table: HandlerTable = {};
  for (const method of METHODS) {
    table[method] = () => {
      throw notImplemented(method, OWNERS[method] ?? "WS-C");
    };
  }
  table["daemon.info"] = (): DaemonInfoResult => ({
    contractVersion: CONTRACT_VERSION,
    daemonVersion: DAEMON_VERSION,
    profile: deps.profile,
    pid: process.pid,
    startedAt: deps.startedAt,
    extension: { connected: false },
    sessions: 0,
  });
  return table;
}
