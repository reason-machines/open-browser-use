// WS-C: leases (15 s heartbeat, 60 s expiry -> finalize, I4) and start-up reconcile (I5).
import { HEARTBEAT_INTERVAL_MS, LEASE_TTL_MS } from "../contract.js";
import type { SessionManager } from "../session/manager.js";

export interface LeaseClock {
  now(): number;
}

export const LEASE_DEFAULTS = { ttlMs: LEASE_TTL_MS, heartbeatMs: HEARTBEAT_INTERVAL_MS } as const;

/** Pure helper so lease logic is unit-testable with a fake clock. */
export function isExpired(lastSeenAt: number, clock: LeaseClock, ttlMs: number = LEASE_TTL_MS): boolean {
  return clock.now() - lastSeenAt > ttlMs;
}

/**
 * One sweep: finalize every session whose lease expired (I4). Children are
 * swept before parents (close() cascades anyway). Returns the swept ids.
 */
export async function sweepExpired(sessions: SessionManager, now: number = sessions.clock.now()): Promise<string[]> {
  const expired = sessions.expired(now);
  // Deepest first so a child's orphans_closed can still reach a live parent.
  const depth = (id: string): number => {
    let d = 0;
    let row = sessions.get(id);
    while (row?.parent) {
      d++;
      row = sessions.get(row.parent);
    }
    return d;
  };
  expired.sort((a, b) => depth(b.id) - depth(a.id));
  const swept: string[] = [];
  for (const row of expired) {
    if (!sessions.get(row.id)) continue;
    await sessions.close(row.id, [], "lease_expired").catch(() => undefined);
    swept.push(row.id);
  }
  return swept;
}

/** Periodic sweeper. `intervalMs` defaults to 1 s so expiry lands within ttl + 1 s. */
export function startLeaseSweeper(sessions: SessionManager, intervalMs = 1_000): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepExpired(sessions)
      .catch(() => undefined)
      .finally(() => (running = false));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * After a daemon restart every client connection is gone. A live agent
 * reconnects (any call renews its lease) well within this window; sessions
 * nobody comes back for are finalized after it instead of a full lease TTL.
 */
export const RECONNECT_GRACE_MS = 10_000;

/**
 * I5 reconcile at daemon start: sessions persisted by a previous daemon whose
 * lease has expired are finalized (owned tabs closed unless the user is looking
 * at them; borrowed released). Leases still live get RECONNECT_GRACE_MS to be
 * renewed by their (reconnecting) agent before they are finalized too.
 */
export async function reconcileOnStart(sessions: SessionManager, graceMs: number = RECONNECT_GRACE_MS): Promise<{ finalized: string[]; kept: string[] }> {
  const now = sessions.clock.now();
  const finalized = await sweepExpired(sessions, now);
  const kept = sessions.list().map((row) => row.id);
  for (const id of kept) sessions.capLease(id, now + graceMs);
  return { finalized, kept };
}
