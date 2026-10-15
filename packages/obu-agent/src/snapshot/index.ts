// WS-D (daemon side): run __obu.takeSnapshot per frame, stitch fKeN, diff, size check.
import type { SnapshotParams, SnapshotResult } from "../contract.js";
import { notImplemented } from "../errors.js";
import type { PageContext } from "../seams.js";
export { stitchFrames } from "./stitch.js";
export { unifiedDiff } from "./diff.js";

export async function takeSnapshot(_page: PageContext, _params: SnapshotParams): Promise<Omit<SnapshotResult, "events">> {
  throw notImplemented("snapshot", "WS-D");
}
