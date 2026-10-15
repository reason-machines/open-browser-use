// WS-D (daemon side): run __obu.takeSnapshot per frame, stitch fKeN, diff, size check.
import { DEFAULT_SNAPSHOT_MAX_CHARS, type SnapshotParams, type SnapshotResult } from "../contract.js";
import { ObuError } from "../errors.js";
import type { InjectedSnapshot, TakeSnapshotOptions } from "../injected/api.js";
import type { FrameHandle, PageContext } from "../seams.js";
import { unifiedDiff } from "./diff.js";
import { stitchFrames, type FrameSnapshot } from "./stitch.js";

export { stitchFrames } from "./stitch.js";
export type { FrameSnapshot } from "./stitch.js";
export { unifiedDiff } from "./diff.js";
export { withAnnotations } from "./annotate.js";

const MAIN_FRAME_RETRIES = 3;
/** Default char budget for interactive snapshots (folds far/bulky subtrees past it). */
export const DEFAULT_INTERACTIVE_BUDGET = 8_000;
const CHILD_FRAME_TIMEOUT_MS = 3_000;

/** Snapshots of one page are serialised (spec). Keyed by the TabCdp object. */
const pageLocks = new WeakMap<object, Promise<unknown>>();
/** frameId → ref of its <iframe> owner in the parent frame, per tab. */
const ownerCache = new WeakMap<object, Map<string, string>>();

function serialise<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const prev = pageLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  pageLocks.set(key, run.catch(() => undefined));
  return run;
}

function frameOfRef(ref: string): number {
  const m = /^f(\d+)e\d+$/.exec(ref);
  return m ? Number(m[1]) : 0;
}

function originOf(url: string, fallback: string): string {
  try {
    const o = new URL(url).origin;
    return o === "null" ? fallback : o;
  } catch {
    return fallback;
  }
}

/** Map an injected-script exception onto a typed error the agent can act on. */
function mapInjectedError(e: unknown, params: SnapshotParams): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("stale_ref")) {
    throw new ObuError("stale_ref", `ref ${params.ref} no longer resolves; take a fresh snapshot`, { ref: params.ref });
  }
  if (msg.includes("selector_not_found")) {
    throw new ObuError("invalid_params", `selector ${JSON.stringify(params.selector)} matched nothing in the main frame`);
  }
  if (e instanceof ObuError) throw e;
  throw new ObuError("internal", `snapshot failed: ${msg}`);
}

async function snapshotFrame(page: PageContext, frame: FrameHandle, opts: TakeSnapshotOptions, timeoutMs?: number): Promise<InjectedSnapshot> {
  const call = page.callInjected<InjectedSnapshot>(frame, "takeSnapshot", [opts]);
  if (!timeoutMs) return call;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`frame f${frame.ordinal} snapshot timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Find the ref of `child`'s <iframe> element in its parent frame:
 * DOM.getFrameOwner on the parent's session → resolve the node in each
 * candidate parent's utility world → __obu.refOf(this). Only the world that
 * snapshotted the owner knows its ref, so the first non-null answer wins.
 */
async function resolveOwnerRef(page: PageContext, child: FrameHandle, frames: FrameHandle[]): Promise<string | undefined> {
  const sessions = [...new Set<string | undefined>([child.sessionId, undefined, ...frames.map((f) => f.sessionId)])];
  for (const sessionId of sessions) {
    let backendNodeId: number | undefined;
    try {
      const owner = await page.cdp.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: child.frameId }, { sessionId, timeoutMs: 1_000 });
      backendNodeId = owner.backendNodeId;
    } catch {
      continue;
    }
    if (!backendNodeId) continue;
    for (const parent of frames) {
      if (parent === child || parent.sessionId !== sessionId) continue;
      let objectId: string | undefined;
      try {
        const res = await page.cdp.send<{ object: { objectId?: string } }>(
          "DOM.resolveNode",
          { backendNodeId, executionContextId: parent.utilityContextId },
          { sessionId, timeoutMs: 1_000 },
        );
        objectId = res.object.objectId;
        if (!objectId) continue;
        const r = await page.cdp.send<{ result: { value?: string | null } }>(
          "Runtime.callFunctionOn",
          { objectId, functionDeclaration: "function(){return globalThis.__obu ? globalThis.__obu.refOf(this) : null}", returnByValue: true },
          { sessionId, timeoutMs: 1_000 },
        );
        if (r.result.value) return r.result.value;
      } catch {
        /* try next candidate */
      } finally {
        if (objectId) page.cdp.send("Runtime.releaseObject", { objectId }, { sessionId }).catch(() => undefined);
      }
    }
    return undefined;
  }
  return undefined;
}

export async function takeSnapshot(page: PageContext, params: SnapshotParams): Promise<Omit<SnapshotResult, "events">> {
  return serialise(page.cdp, () => takeSnapshotUnlocked(page, params));
}

async function takeSnapshotUnlocked(page: PageContext, params: SnapshotParams): Promise<Omit<SnapshotResult, "events">> {
  const maxChars = params.maxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS;
  const warnings: string[] = [];
  // Budget: explicit (0 = off), else 8K for interactive, else just under maxChars
  // so a big page folds instead of failing with snapshot_too_large.
  const budget = params.budget !== undefined ? Math.max(0, params.budget) : params.interactive ? Math.min(DEFAULT_INTERACTIVE_BUDGET, maxChars) : Math.max(2_000, maxChars - 1_000);
  const base = { interactive: params.interactive, showHidden: params.showHidden };

  // Main frame, retried (context churn during navigation).
  let frames: FrameHandle[] = [];
  let main: InjectedSnapshot | undefined;
  const scopedOrdinal = params.ref ? frameOfRef(params.ref) : 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAIN_FRAME_RETRIES && !main; attempt++) {
    try {
      frames = await page.frames();
      const target = frames.find((f) => f.ordinal === scopedOrdinal);
      if (!target) {
        if (params.ref) throw new ObuError("stale_ref", `ref ${params.ref} belongs to a frame that is gone; take a fresh snapshot`, { ref: params.ref });
        throw new Error("main frame unavailable");
      }
      await registerClosedRoots(page, frames).catch(() => undefined);
      // Leave room for the `- title:` header and stitched child frames.
      main = await snapshotFrame(page, target, { ...base, budget: budget ? Math.max(1_000, budget - 300) : 0, ref: params.ref, selector: params.selector, frameOrdinal: target.ordinal });
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof ObuError || msg.includes("stale_ref") || msg.includes("selector_not_found")) mapInjectedError(e, params);
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
  if (!main) mapInjectedError(lastErr, params);

  // Child frames: everything except the snapshot root's frame, in parallel.
  // When scoped by ref/selector, only frames whose owner falls inside the
  // scoped subtree are stitched (resolved via owner refs below).
  const rootFrame = frames.find((f) => f.ordinal === scopedOrdinal)!;
  const children = frames.filter((f) => f !== rootFrame && (scopedOrdinal === 0 || f.ordinal > scopedOrdinal));
  const childResults = await Promise.all(
    children.map(async (f): Promise<FrameSnapshot | null> => {
      try {
        const snap = await snapshotFrame(page, f, { ...base, budget: budget ? Math.min(Math.floor(budget / 4), 3_000) : 0, frameOrdinal: f.ordinal }, CHILD_FRAME_TIMEOUT_MS);
        return { ordinal: f.ordinal, origin: originOf(snap.url, f.origin), snapshot: snap };
      } catch (e) {
        warnings.push(`iframe f${f.ordinal} (${f.origin || "unknown origin"}) could not be read: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }),
  );
  const childSnaps = childResults.filter((x): x is FrameSnapshot => !!x);

  // Map child frames onto placeholders (cached per tab, validated against current yaml).
  let cache = ownerCache.get(page.cdp);
  if (!cache) {
    cache = new Map();
    ownerCache.set(page.cdp, cache);
  }
  const allYaml = [main.yaml, ...childSnaps.map((c) => c.snapshot.yaml)].join("\n");
  await Promise.all(
    childSnaps.map(async (c) => {
      const handle = children.find((f) => f.ordinal === c.ordinal)!;
      const cached = cache!.get(handle.frameId);
      if (cached && allYaml.includes(`[ref=${cached}]`)) {
        c.parentRef = cached;
        return;
      }
      const ref = await resolveOwnerRef(page, handle, frames);
      if (ref) {
        cache!.set(handle.frameId, ref);
        c.parentRef = ref;
      }
    }),
  );

  let stitched: string;
  if (params.ref || params.selector) {
    // Scoped: only inline frames whose placeholder is inside the scoped tree.
    const inScope = childSnaps.filter((c) => c.parentRef);
    stitched = stitchFrames([{ ordinal: 0, origin: "", snapshot: main }, ...inScope]);
    stitched = dropUnplacedFrames(stitched);
  } else {
    stitched = stitchFrames([{ ordinal: 0, origin: originOf(main.url, ""), snapshot: main }, ...childSnaps]);
  }

  const mainFrame = frames.find((f) => f.ordinal === 0);
  const { title, url } = scopedOrdinal === 0 || !mainFrame ? main : await pageInfo(page, mainFrame, main);
  const tree = `- title: ${JSON.stringify(title)} [url=${url}]${stitched ? "\n" + stitched : ""}`;
  const refCount = main.refs + childSnaps.reduce((n, c) => n + c.snapshot.refs, 0);
  const folded = (main.collapsed ?? 0) + childSnaps.reduce((n, c) => n + (c.snapshot.collapsed ?? 0), 0);
  if (folded) warnings.push(`${folded} subtree(s) folded to fit the ${budget}-char budget; snapshot({ref}) a [collapsed] node to expand it.`);

  if (tree.length > maxChars) {
    const advice = params.interactive
      ? "Scope the snapshot with `ref` (a container's ref) or `selector`, or raise maxChars."
      : "Retry with interactive:true (refs, headings and landmarks only), or scope with `ref`/`selector`, or raise maxChars.";
    throw new ObuError("snapshot_too_large", `snapshot is ${tree.length} chars (> maxChars ${maxChars}). ${advice}`, { advice, tabId: page.cdp.tabId });
  }

  const comparable = !params.ref && !params.selector && !params.interactive;
  const diff = comparable ? unifiedDiff(page.previousTree, tree) : "";
  return { tree, diff, url, title, tabId: page.cdp.tabId, refCount, warnings };
}

/** Remove trailing `- iframe [frame=fK]` blocks (frames outside a scoped subtree). */
function dropUnplacedFrames(yaml: string): string {
  const lines = yaml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/^- iframe \[frame=f-?\d+\]/.test(l)) {
      skipping = true;
      continue;
    }
    if (skipping && l.startsWith("  ")) continue;
    skipping = false;
    out.push(l);
  }
  return out.join("\n");
}

async function pageInfo(page: PageContext, frame: FrameHandle, fallback: InjectedSnapshot): Promise<{ title: string; url: string }> {
  try {
    // maxDepth -1: no walk, just title/url.
    const s = await page.callInjected<InjectedSnapshot>(frame, "takeSnapshot", [{ interactive: true, maxDepth: -1, frameOrdinal: frame.ordinal }]);
    return { title: s.title, url: s.url };
  } catch {
    return { title: fallback.title, url: fallback.url };
  }
}

// ---------------------------------------------------------------------------
// Closed shadow roots: the isolated world cannot see them, CDP can.
// DOM.getDocument{depth:-1,pierce:true} lists every shadow root with its type;
// each closed root is resolved into the frame's utility world and handed to
// __obu.registerClosedRoot. Runs once per (tab, document, candidate count).
// ---------------------------------------------------------------------------

interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  frameId?: string;
  children?: DomNode[];
  shadowRoots?: (DomNode & { shadowRootType?: "open" | "closed" | "user-agent" })[];
  contentDocument?: DomNode;
}

const closedRootPass = new WeakMap<object, { doc: string; candidates: number; at: number }>();

async function registerClosedRoots(page: PageContext, frames: FrameHandle[]): Promise<void> {
  const main = frames.find((f) => f.ordinal === 0);
  if (!main) return;
  // Once per document; again only when new candidates appear (SPAs), at most every 5 s.
  // The throttle is checked before the candidate scan: the scan walks every element (layout
  // reads on empty ones) and would otherwise tax every snapshot of the same document.
  const docKey = `${main.frameId}|${main.utilityContextId}`;
  const prev = closedRootPass.get(page.cdp);
  const now = Date.now();
  if (prev && prev.doc === docKey && now - prev.at < 5_000) return;
  const candidates = await page.callInjected<number>(main, "closedRootCandidates", []).catch(() => 0);
  if (!candidates) {
    closedRootPass.set(page.cdp, { doc: docKey, candidates: 0, at: now });
    return;
  }
  if (prev && prev.doc === docKey && candidates <= prev.candidates) {
    closedRootPass.set(page.cdp, { ...prev, at: now });
    return;
  }
  closedRootPass.set(page.cdp, { doc: docKey, candidates, at: now });
  // Group frames by CDP session (main session = undefined; OOPIFs have their own).
  const bySession = new Map<string | undefined, FrameHandle[]>();
  for (const f of frames) bySession.set(f.sessionId, [...(bySession.get(f.sessionId) ?? []), f]);
  for (const [sessionId, sessionFrames] of bySession) {
    let doc: { root: DomNode };
    try {
      doc = await page.cdp.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true }, { sessionId, timeoutMs: 3_000 });
    } catch {
      continue;
    }
    const top = sessionFrames.find((f) => !f.sessionId || f.sessionId === sessionId) ?? sessionFrames[0];
    const found: { backendNodeId: number; frame: FrameHandle }[] = [];
    const walk = (n: DomNode, frame: FrameHandle) => {
      for (const sr of n.shadowRoots ?? []) {
        if (sr.shadowRootType === "closed") found.push({ backendNodeId: sr.backendNodeId, frame });
        walk(sr, frame);
      }
      for (const c of n.children ?? []) walk(c, frame);
      if (n.contentDocument) {
        const child = sessionFrames.find((f) => f.frameId === n.frameId) ?? frame;
        walk(n.contentDocument, child);
      }
    };
    walk(doc.root, top);
    await Promise.all(
      found.slice(0, 200).map(async ({ backendNodeId, frame }) => {
        let objectId: string | undefined;
        try {
          const r = await page.cdp.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId, executionContextId: frame.utilityContextId }, { sessionId, timeoutMs: 1_000 });
          objectId = r.object.objectId;
          if (!objectId) return;
          await page.cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return globalThis.__obu ? globalThis.__obu.registerClosedRoot(this) : false}", returnByValue: true }, { sessionId, timeoutMs: 1_000 });
        } catch {
          /* best effort */
        } finally {
          if (objectId) page.cdp.send("Runtime.releaseObject", { objectId }, { sessionId }).catch(() => undefined);
        }
      }),
    );
  }
}
