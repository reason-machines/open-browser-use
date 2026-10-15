// WS-D: replace `- iframe [ref=X]` placeholder lines with the child frame's YAML, re-indented.
import type { InjectedSnapshot } from "../injected/api.js";

export interface FrameSnapshot {
  ordinal: number;
  /** Ref of the <iframe> element in its parent frame. */
  parentRef?: string;
  origin: string;
  snapshot: InjectedSnapshot;
}

export function stitchFrames(_frames: FrameSnapshot[]): string {
  throw new Error("stitchFrames not implemented (WS-D)");
}
