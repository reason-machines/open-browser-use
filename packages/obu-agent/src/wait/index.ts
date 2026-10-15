// WS-E: performActionAndWait with the A6 timings. Timeouts are warnings, not errors.
import type { Settled } from "../contract.js";
import type { PageContext } from "../seams.js";

export const SETTLE_TIMINGS = {
  postActionMs: 150,
  actionRequestGraceMs: 1200,
  navProbeIntervalMs: 100,
  navNetworkQuietMs: 1500,
  navRedirectGuardMs: 1000,
  spaDelayMs: 500,
  spaSettleMaxMs: 750,
  domSettleMs: 300,
  domQuietWindowMs: 350,
  domMutationRatioDone: 0.01,
  networkPollMs: 50,
  capMs: 8000,
} as const;

/** Network resource types ignored when deciding "quiet". */
export const IGNORED_RESOURCE_TYPES = ["WebSocket", "EventSource", "Ping", "Prefetch", "CSPViolationReport"] as const;

export async function performActionAndWait(_page: PageContext, action: () => Promise<void>): Promise<Settled> {
  const started = Date.now();
  await action();
  return { kind: "none", ms: Date.now() - started, warning: "settle not implemented (WS-E)" };
}
