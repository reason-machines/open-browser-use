// WS-D: replace `- iframe [ref=X]` placeholder lines with the child frame's YAML, re-indented.
import type { InjectedSnapshot } from "../injected/api.js";

export interface FrameSnapshot {
  ordinal: number;
  /** Ref of the <iframe> element in its parent frame. */
  parentRef?: string;
  origin: string;
  snapshot: InjectedSnapshot;
}

const PLACEHOLDER = /^(\s*)- iframe\b(.*)\[ref=([a-z0-9]+)\](.*)$/;

/**
 * Stitch frame snapshots into one tree. frames[0] (ordinal 0) is the main
 * frame. A child frame whose parentRef matches a placeholder is inlined under
 * it (recursively, so nested iframes work); unmatched child frames are
 * appended at the end under `- iframe [frame=fK] [origin=…]` so nothing is lost.
 */
export function stitchFrames(frames: FrameSnapshot[]): string {
  if (!frames.length) return "";
  const byParentRef = new Map<string, FrameSnapshot>();
  for (const f of frames) if (f.ordinal !== 0 && f.parentRef) byParentRef.set(f.parentRef, f);
  const used = new Set<FrameSnapshot>();

  const expand = (yaml: string, depth: number): string[] => {
    const out: string[] = [];
    for (const line of yaml ? yaml.split("\n") : []) {
      const m = PLACEHOLDER.exec(line);
      const child = m ? byParentRef.get(m[3]) : undefined;
      if (!m || !child || used.has(child) || depth > 8) {
        out.push(line);
        continue;
      }
      used.add(child);
      const indent = m[1];
      const head = line.endsWith(":") ? line : `${line}:`;
      const inner = expand(child.snapshot.yaml, depth + 1);
      if (!inner.length) {
        out.push(line);
        continue;
      }
      out.push(head);
      for (const l of inner) out.push(`${indent}  ${l}`);
    }
    return out;
  };

  const main = frames.find((f) => f.ordinal === 0) ?? frames[0];
  used.add(main);
  const lines = expand(main.snapshot.yaml, 0);
  for (const f of frames) {
    if (used.has(f)) continue;
    const inner = expand(f.snapshot.yaml, 1);
    if (!inner.length) continue;
    lines.push(`- iframe [frame=f${f.ordinal}]${f.origin ? ` [origin=${f.origin}]` : ""}:`);
    for (const l of inner) lines.push(`  ${l}`);
  }
  return lines.join("\n");
}
