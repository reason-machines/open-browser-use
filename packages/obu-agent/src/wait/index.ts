// WS-E: performActionAndWait with the A6 timings, plus the `wait` method.
// Event-driven (CDP Network/Page events + a MutationObserver probe in the
// utility world), timed with setTimeout. Settle timeouts are warnings, not errors.
import type { Settled, SystemEvent, WaitParams, WaitResult } from "../contract.js";
import { ObuError } from "../errors.js";
import type { FrameHandle, PageContext, TabCdp } from "../seams.js";
import { fnHasText, fnQuery, fnSettleProbe } from "../actions/page-fns.js";
import { callInFrame } from "../actions/target.js";

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
  /** A post-action window with at most this many mutation records counts as settled (a counter/label update). */
  domSmallChangeRecords: 2,
  networkPollMs: 50,
  capMs: 8000,
} as const;

/** Network resource types ignored when deciding "quiet". */
export const IGNORED_RESOURCE_TYPES = ["WebSocket", "EventSource", "Ping", "Prefetch", "CSPViolationReport"] as const;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Inflight {
  started: number;
  type: string;
}

/** Per-tab activity: in-flight requests and main-frame navigations (one per TabCdp). */
export class TabActivity {
  readonly inflight = new Map<string, Inflight>();
  /** Increments on every request start (to find requests started by an action). */
  requestSeq = 0;
  private readonly requestSeqOf = new Map<string, number>();
  navSeq = 0;
  spaSeq = 0;
  navPending = false;
  lastUrl = "";
  lastNetworkAt = 0;
  private readonly unsubs: (() => void)[] = [];
  private enabled: Promise<void> | null = null;

  constructor(private readonly cdp: TabCdp) {
    const key = (id: string, sessionId?: string) => `${sessionId ?? ""}:${id}`;
    const done = (p: { requestId: string }, sessionId?: string) => {
      const k = key(p.requestId, sessionId);
      if (this.inflight.delete(k)) this.lastNetworkAt = Date.now();
      this.requestSeqOf.delete(k);
    };
    this.unsubs.push(
      cdp.on("Network.requestWillBeSent", (p: { requestId: string; type?: string; frameId?: string }, sessionId?: string) => {
        const type = p.type ?? "Other";
        if ((IGNORED_RESOURCE_TYPES as readonly string[]).includes(type)) return;
        const k = key(p.requestId, sessionId);
        if (!this.inflight.has(k)) {
          this.requestSeq++;
          this.requestSeqOf.set(k, this.requestSeq);
        }
        this.inflight.set(k, { started: Date.now(), type });
        this.lastNetworkAt = Date.now();
      }),
      cdp.on("Network.loadingFinished", done),
      cdp.on("Network.loadingFailed", done),
      cdp.on("Network.webSocketCreated", (p: { requestId: string }, s?: string) => done(p, s)),
      cdp.on("Page.frameStartedNavigating", (p: { frameId: string }, sessionId?: string) => {
        if (!sessionId && p.frameId === cdp.targetId) this.navPending = true;
      }),
      cdp.on("Page.frameRequestedNavigation", (p: { frameId: string }, sessionId?: string) => {
        if (!sessionId && p.frameId === cdp.targetId) this.navPending = true;
      }),
      cdp.on("Page.frameStartedLoading", (p: { frameId: string }, sessionId?: string) => {
        if (!sessionId && p.frameId === cdp.targetId) this.navPending = true;
      }),
      cdp.on("Page.frameNavigated", (p: { frame: { id: string; parentId?: string; url: string } }, sessionId?: string) => {
        if (sessionId || p.frame.parentId) return;
        this.navSeq++;
        this.lastUrl = p.frame.url;
        // Old document's requests never finish in the new one.
        for (const [k, v] of this.inflight) if (v.type !== "Document") this.inflight.delete(k);
      }),
      cdp.on("Page.frameStoppedLoading", (p: { frameId: string }, sessionId?: string) => {
        if (!sessionId && p.frameId === cdp.targetId) this.navPending = false;
      }),
      cdp.on("Page.loadEventFired", () => { this.navPending = false; }),
      cdp.on("Page.navigatedWithinDocument", (p: { frameId: string; url: string }, sessionId?: string) => {
        if (sessionId || p.frameId !== cdp.targetId) return;
        this.spaSeq++;
        this.lastUrl = p.url;
      }),
    );
  }

  /** Idempotent: Page + Network domains on the main session (never Runtime.enable). */
  ensureEnabled(): Promise<void> {
    this.enabled ??= Promise.all([
      this.cdp.send("Page.enable").catch(() => undefined),
      this.cdp.send("Network.enable").catch(() => undefined),
    ]).then(() => undefined);
    return this.enabled;
  }

  /** In-flight requests that started after `sinceSeq`. */
  pendingSince(sinceSeq: number): number {
    let n = 0;
    for (const [k] of this.inflight) if ((this.requestSeqOf.get(k) ?? 0) > sinceSeq) n++;
    return n;
  }

  dispose(): void {
    for (const u of this.unsubs) u();
  }
}

const activities = new WeakMap<TabCdp, TabActivity>();
export function tabActivity(cdp: TabCdp): TabActivity {
  let a = activities.get(cdp);
  if (!a) {
    a = new TabActivity(cdp);
    activities.set(cdp, a);
  }
  return a;
}

type Probe = ReturnType<typeof fnSettleProbe>;

let probeCounter = 0;
async function probe(page: PageContext, token: string): Promise<Probe | null> {
  try {
    const frames = await page.frames();
    if (!frames.length) return null;
    const r = await callInFrame<Probe>(page, frames[0], fnSettleProbe, [token], { timeoutMs: 1000 });
    return r.value ?? null;
  } catch {
    return null; // context being replaced mid-navigation
  }
}

function pageReady(p: Probe | null): boolean {
  return !!p && p.readyState !== "loading" && (p.interactiveCount > 0 || p.landmarks > 0 || p.textLen >= 20);
}

/**
 * Run `action`, then wait until the page has settled:
 * nav -> ready + network quiet; SPA URL change -> short settle; otherwise a
 * mutation-ratio settle. Capped at 8 s (warning, never an error).
 */
export async function performActionAndWait(page: PageContext, action: () => Promise<void>, opts: { capMs?: number } = {}): Promise<Settled> {
  const T = SETTLE_TIMINGS;
  const cap = opts.capMs ?? T.capMs;
  const activity = tabActivity(page.cdp);
  await activity.ensureEnabled();
  const token = `s${++probeCounter}`;
  // Prime the mutation counter so the first post-action sample measures the action window.
  await probe(page, token);
  const navBefore = activity.navSeq;
  const spaBefore = activity.spaSeq;
  const reqBefore = activity.requestSeq;
  const started = Date.now();
  const deadline = started + cap;
  const left = () => deadline - Date.now();
  const done = (kind: Settled["kind"], warning?: string): Settled => ({ kind, ms: Date.now() - started, ...(warning ? { warning } : {}) });

  await action();

  // Post-action window (150 ms), cut short only by the cap.
  await sleep(Math.min(T.postActionMs, Math.max(0, left())));
  const navigated = () => activity.navSeq !== navBefore || activity.navPending;

  // Requests started by the action get up to 1.2 s (unless a navigation took over).
  const graceEnd = Math.min(Date.now() + T.actionRequestGraceMs, deadline);
  while (Date.now() < graceEnd && activity.pendingSince(reqBefore) > 0 && !navigated()) await sleep(T.networkPollMs);

  if (navigated()) {
    // Main-frame navigation: probe until ready, then network quiet (bounded), redirect guard.
    let ready: Probe | null = null;
    let committed = false;
    while (left() > 0) {
      committed = activity.navSeq !== navBefore;
      if (!committed && !activity.navPending) break; // aborted / became a download
      ready = await probe(page, token);
      if (committed && pageReady(ready) && (!activity.navPending || ready!.readyState === "complete")) break;
      await sleep(Math.min(T.navProbeIntervalMs, Math.max(0, left())));
    }
    if (committed) {
      if (left() <= 0) return done("nav", `page still loading after ${cap} ms; continuing (take a snapshot to check)`);
      const quietEnd = Math.min(Date.now() + T.navNetworkQuietMs, deadline);
      while (Date.now() < quietEnd && activity.inflight.size > 0) await sleep(T.networkPollMs);
      if (ready && ready.interactiveCount === 0) {
        // Redirect guard: interstitials / client-side redirects have nothing to click yet.
        const guardEnd = Math.min(Date.now() + T.navRedirectGuardMs, deadline);
        const navAt = activity.navSeq;
        while (Date.now() < guardEnd) {
          await sleep(T.navProbeIntervalMs);
          if (activity.navSeq !== navAt) {
            while (left() > 0) {
              const q = await probe(page, token);
              if (pageReady(q) && !activity.navPending) break;
              await sleep(T.navProbeIntervalMs);
            }
            break;
          }
          const p = await probe(page, token);
          if (p && p.interactiveCount > 0) break;
        }
      }
      return done("nav", left() <= 0 ? `navigation settle hit the ${cap} ms cap` : undefined);
    }
  }

  if (activity.spaSeq !== spaBefore) {
    await sleep(Math.min(T.spaDelayMs, Math.max(0, left())));
    const w = await domSettle(page, token, activity, Math.min(T.spaSettleMaxMs, Math.max(0, left())));
    return done("spa", w);
  }

  const w = await domSettle(page, token, activity, Math.min(T.domSettleMs, Math.max(0, left())), true);
  return done("dom", w);
}

/**
 * Settle on DOM quiet: sample the mutation ratio every 50 ms; done when two
 * consecutive windows are under 1% and no request is in flight. The post-action
 * window counts as the first sample when `firstWindowCounts`.
 */
async function domSettle(page: PageContext, token: string, activity: TabActivity, maxMs: number, firstWindowCounts = false): Promise<string | undefined> {
  const T = SETTLE_TIMINGS;
  const end = Date.now() + maxMs;
  let quiet = 0;
  let first = true;
  for (;;) {
    const p = await probe(page, token);
    const calm = !!p && activity.inflight.size === 0 && (p.mutationRatio < T.domMutationRatioDone || (first && firstWindowCounts && p.mutations <= T.domSmallChangeRecords));
    if (calm) {
      quiet++;
      // Two quiet windows in a row; a calm post-action window (a small, finished update) is enough on its own.
      if (quiet >= 2 || (first && firstWindowCounts)) return undefined;
    } else {
      quiet = 0;
    }
    first = false;
    if (Date.now() >= end) return undefined; // bounded settle: a busy page is not an error
    await sleep(Math.min(T.networkPollMs, Math.max(0, end - Date.now())));
  }
}

// ---------------------------------------------------------------------------
// `wait` method
// ---------------------------------------------------------------------------

/**
 * Hooks WS-C calls so `wait{for:'dialog'|'popup'|'download'}` can resolve:
 * - `deliverSystemEvent(cdp, event)` for every SystemEvent WS-C emits on a tab;
 * - `takePendingDialogAction(cdp)` from the dialog policy before auto-answering.
 */
type Waiter = { types: SystemEvent["type"][]; resolve: (e: SystemEvent) => void };
const eventWaiters = new WeakMap<TabCdp, Set<Waiter>>();
const dialogActions = new WeakMap<TabCdp, { accept: boolean; promptText?: string }[]>();

export function deliverSystemEvent(cdp: TabCdp, event: SystemEvent): void {
  const set = eventWaiters.get(cdp);
  if (!set) return;
  for (const w of [...set]) {
    if (w.types.includes(event.type)) {
      set.delete(w);
      w.resolve(event);
    }
  }
}

export function takePendingDialogAction(cdp: TabCdp): { accept: boolean; promptText?: string } | undefined {
  return dialogActions.get(cdp)?.shift();
}

function waitForEvent(cdp: TabCdp, types: SystemEvent["type"][], timeoutMs: number): Promise<SystemEvent | null> {
  let set = eventWaiters.get(cdp);
  if (!set) eventWaiters.set(cdp, (set = new Set()));
  return new Promise((resolve) => {
    const w: Waiter = { types, resolve: (e) => { clearTimeout(timer); resolve(e); } };
    const timer = setTimeout(() => { set!.delete(w); resolve(null); }, timeoutMs);
    set!.add(w);
  });
}

function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) return url.includes(pattern);
  const re = new RegExp(`^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
  return re.test(url);
}

/**
 * `wait` for selector | text | url | settled | dialog | popup | download.
 * Polling conditions run every 100 ms in the utility world (no page-world access).
 */
export async function waitFor(page: PageContext, params: WaitParams): Promise<WaitResult> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const timeout = (stage: string, what: string): never => {
    throw new ObuError("timeout", `Timed out after ${timeoutMs} ms waiting for ${what}.`, { stage });
  };
  const frame = async (): Promise<FrameHandle | null> => (await page.frames())[0] ?? null;
  switch (params.for) {
    case "selector":
    case "text": {
      const needle = params.for === "selector" ? params.selector : params.text;
      if (!needle) throw new ObuError("invalid_params", `wait for '${params.for}' needs \`${params.for}\`.`);
      while (Date.now() < deadline) {
        try {
          const f = await frame();
          if (f) {
            const ok = params.for === "selector"
              ? !(await callInFrame(page, f, fnQuery, [needle], { returnByValue: false })).isNull
              : (await callInFrame<boolean>(page, f, fnHasText, [needle])).value;
            if (ok) return { ok: true };
          }
        } catch { /* navigating */ }
        await sleep(100);
      }
      return timeout(params.for, params.for === "selector" ? `selector "${needle}"` : `text "${needle}"`);
    }
    case "url": {
      if (!params.url) throw new ObuError("invalid_params", "wait for 'url' needs `url` (substring or glob).");
      const activity = tabActivity(page.cdp);
      await activity.ensureEnabled();
      while (Date.now() < deadline) {
        const f = await frame().catch(() => null);
        let current = activity.lastUrl;
        if (f) {
          try { current = (await callInFrame<string>(page, f, function () { return location.href; })).value; } catch { /* navigating */ }
        }
        if (current && urlMatches(current, params.url)) return { ok: true };
        await sleep(100);
      }
      return timeout("url", `URL matching "${params.url}"`);
    }
    case "settled": {
      const settled = await performActionAndWait(page, async () => undefined, { capMs: Math.min(timeoutMs, SETTLE_TIMINGS.capMs) });
      return { ok: true, warnings: settled.warning ? [settled.warning] : undefined };
    }
    case "dialog": {
      if (params.dialogAction) {
        const list = dialogActions.get(page.cdp) ?? [];
        list.push(params.dialogAction);
        dialogActions.set(page.cdp, list);
      }
      const e = await waitForEvent(page.cdp, ["dialog"], timeoutMs);
      if (!e) {
        if (params.dialogAction) dialogActions.get(page.cdp)?.pop();
        return timeout("dialog", "a dialog");
      }
      return { ok: true, event: e };
    }
    case "popup": {
      const e = await waitForEvent(page.cdp, ["popup_opened"], timeoutMs);
      if (!e) return timeout("popup", "a popup / new tab");
      return { ok: true, event: e, tab: e.type === "popup_opened" ? e.tab : undefined };
    }
    case "download": {
      const { downloadTracker } = await import("../files/index.js");
      const d = await downloadTracker(page).waitNext(timeoutMs);
      if (!d) return timeout("download", "a download to finish");
      return { ok: d.state === "complete", download: d, warnings: d.state === "complete" ? undefined : [`download ${d.state}`] };
    }
    default:
      throw new ObuError("invalid_params", `Unknown wait condition "${String((params as { for: string }).for)}".`);
  }
}
