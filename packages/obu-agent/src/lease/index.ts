// WS-C: leases (15 s heartbeat, 60 s expiry -> finalize, I4) and start-up reconcile (I5).
import { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from "../contract.js";

export interface LeaseClock {
  now(): number;
}

export const LEASE_DEFAULTS = { ttlMs: LEASE_TTL_MS, heartbeatMs: HEARTBEAT_INTERVAL_MS } as const;

/** Pure helper so lease logic is unit-testable with a fake clock. */
export function isExpired(lastSeenAt: number, clock: LeaseClock, ttlMs: number = LEASE_TTL_MS): boolean {
  return clock.now() - lastSeenAt > ttlMs;
}
