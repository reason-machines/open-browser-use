/**
 * Injected-world API: the contract between WS-D (snapshot engine, which builds
 * the bundle) and WS-C/WS-E (which inject it and call it).
 *
 * The bundle is evaluated in an isolated world named UTILITY_WORLD_NAME via
 * Page.addScriptToEvaluateOnNewDocument{worldName} + Page.createIsolatedWorld,
 * once per frame (main frame + every OOPIF child session). It installs
 * `globalThis.__obu`. The daemon calls it with Runtime.callFunctionOn /
 * Runtime.evaluate using the isolated world's executionContextId — never
 * Runtime.enable.
 *
 * Clean room: built from Playwright's Apache-2.0 aria snapshot/roleUtils and
 * our own engine. Do not copy any Aside bundle.
 */

export interface TakeSnapshotOptions {
  interactive?: boolean;
  ref?: string;
  selector?: string;
  showHidden?: boolean;
  /** Default 50. */
  maxDepth?: number;
  /** 0 for the main frame; K for the K-th stitched iframe (refs become `fKeN`). */
  frameOrdinal: number;
}

export interface InjectedSnapshot {
  /** YAML for this frame only; child frames appear as `- iframe [ref=…] [origin=…]` placeholders. */
  yaml: string;
  refs: number;
  /** Child frames to stitch in, in document order. */
  iframes: { ref: string; frameName?: string; src: string }[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ReadyFailure = "detached" | "hidden" | "disabled" | "unstable" | "not_editable" | "timeout";

export interface SettleProbe {
  readyState: DocumentReadyState;
  /** Visible interactive elements. */
  interactiveCount: number;
  /** Visible text length (capped). */
  textLen: number;
  /** Fraction of nodes mutated since the previous probe (MutationObserver). */
  mutationRatio: number;
  landmarks: number;
}

export interface ObuInjectedApi {
  version: string;
  takeSnapshot(opts: TakeSnapshotOptions): InjectedSnapshot;
  /** Cache-first, then role+name+nth fallback over ≤5000 nodes. */
  deref(ref: string): Element | null;
  /** Actionability: attached, visible, enabled, stable (same box 32 ms apart, timed with setTimeout, not rAF). */
  waitForReady(
    ref: string,
    opts: { timeoutMs: number; enabled?: boolean; editable?: boolean },
  ): Promise<{ ok: true; rect: Rect } | { ok: false; reason: ReadyFailure }>;
  /** elementFromPoint through shadow roots; ok when the hit is the target or its descendant. */
  checkHitTarget(ref: string, x: number, y: number): { ok: boolean; hit?: string };
  resolvePointerTarget(x: number, y: number): { ref?: string; tag: string };
  checkEditable(ref: string): boolean;
  settleProbe(): SettleProbe;
  /** Set-of-marks overlay: red numbered boxes per ref (z-index 2147483647). */
  annotate(on: boolean): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __obu: ObuInjectedApi | undefined;
}
