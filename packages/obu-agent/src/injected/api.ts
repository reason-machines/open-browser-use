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
  /**
   * Target rendered size in chars. When the tree is larger, far-from-viewport
   * and bulky subtrees fold into `[collapsed]` one-liners that carry a ref
   * (snapshot({ref}) expands them). 0/undefined = no compaction.
   */
  budget?: number;
}

export interface InjectedSnapshot {
  /** YAML for this frame only; child frames appear as `- iframe [ref=…] [origin=…]` placeholders. */
  yaml: string;
  refs: number;
  /** Subtrees folded to fit `budget` (0 when it fit). */
  collapsed?: number;
  /** Child frames to stitch in, in document order. */
  iframes: { ref: string; frameName?: string; src: string }[];
  /** document.title of this frame. */
  title: string;
  /** location.href of this frame. */
  url: string;
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
  /**
   * Ref of an element (null if it has none). The daemon calls this with
   * `Runtime.callFunctionOn` on an <iframe> owner node (from DOM.getFrameOwner)
   * to map child frames onto their `- iframe [ref=…]` placeholders.
   */
  refOf(el: Element): string | null;
  /**
   * Register a closed shadow root. The daemon finds closed roots with
   * DOM.getDocument{depth:-1,pierce:true}, resolves each root node into this
   * world (DOM.resolveNode{executionContextId}) and calls this with `this` =
   * the ShadowRoot. Walks, hit tests and deref then enter it.
   */
  registerClosedRoot(root: ShadowRoot): boolean;
  /** Count (capped ~50) of custom-element hosts without a reachable shadow root; 0 → skip the CDP pass. */
  closedRootCandidates(): number;
}

declare global {
  // eslint-disable-next-line no-var
  var __obu: ObuInjectedApi | undefined;
}
