/**
 * Internal seams between streams. WS-C provides these objects; WS-D/WS-E
 * consume them. Changing a seam = update docs/agent/contract.md §Seams in the
 * same commit and tell the other streams (BACKLOG.md).
 */
import type { SystemEvent, TabId, TargetId } from "./contract.js";

/** A SystemEvent before the session stamps it (distributive: keeps each variant's fields). */
export type SystemEventInput = SystemEvent extends infer E ? (E extends SystemEvent ? Omit<E, "seq" | "at" | "sessionId"> : never) : never;

/** Raw CDP access to one tab, already attached. Implemented by WS-C over the native host. */
export interface TabCdp {
  readonly tabId: TabId;
  readonly targetId: TargetId;
  /**
   * Send a CDP command. `sessionId` routes to a flat OOPIF child session
   * (from Target.attachedToTarget); omitted = the tab's main session.
   */
  send<T = unknown>(method: string, params?: Record<string, unknown>, opts?: { sessionId?: string; timeoutMs?: number }): Promise<T>;
  /** Subscribe to CDP events for this tab (all sessions). Returns unsubscribe. */
  on(event: string, handler: (params: any, sessionId?: string) => void): () => void;
}

/** A frame the daemon can evaluate in: main frame (ordinal 0) or an iframe. */
export interface FrameHandle {
  /** 0 = main frame; K = K-th iframe in stitch order (refs `fKeN`). */
  ordinal: number;
  frameId: string;
  /** Child session for OOPIFs; undefined for same-process frames. */
  sessionId?: string;
  /** Isolated world execution context id where `__obu` lives. */
  utilityContextId: number;
  origin: string;
}

/**
 * Everything a page operation (snapshot, act, wait, screenshot) needs.
 * WS-C builds one per call while holding the tab mutex; focus emulation is on
 * for its duration (I7).
 */
export interface PageContext {
  readonly sessionId: string;
  readonly cdp: TabCdp;
  /** Frames in stitch order; index 0 is the main frame. Refreshed by WS-C on navigation/attach. */
  frames(): Promise<FrameHandle[]>;
  /** Call a `__obu` method in a frame's utility world (Runtime.callFunctionOn, returnByValue). */
  callInjected<T = unknown>(frame: FrameHandle, method: string, args: unknown[]): Promise<T>;
  /** Resolve a ref (`eN` / `fKeN`) to its frame + the CDP RemoteObjectId of the element. */
  resolveRef(ref: string): Promise<{ frame: FrameHandle; objectId: string } | null>;
  /** Queue a steering event for the session (appears in this call's result). */
  emit(event: SystemEventInput): void;
  /** Directory for artefacts (screenshots, downloads, fetched bodies) for this session. */
  readonly artifactDir: string;
  /** Previous snapshot tree of this (session, tab), for diffing. */
  previousTree?: string;
}
