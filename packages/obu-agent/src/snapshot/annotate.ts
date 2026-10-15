// WS-D: toggle the set-of-marks overlay in every frame around a screenshot.
//
// The overlay draws red boxes labelled with each visible ref (from the most
// recent snapshot of that frame) at z-index 2147483647 inside a closed shadow
// root, so page CSS cannot restyle it; it is removed in `finally`.
import type { FrameHandle, PageContext } from "../seams.js";

async function setAll(page: PageContext, frames: FrameHandle[], on: boolean): Promise<void> {
  await Promise.all(frames.map((f) => page.callInjected(f, "annotate", [on]).catch(() => undefined)));
}

export async function withAnnotations<T>(page: PageContext, fn: () => Promise<T>): Promise<T> {
  let frames: FrameHandle[] = [];
  try {
    frames = await page.frames();
  } catch {
    return fn();
  }
  await setAll(page, frames, true);
  try {
    return await fn();
  } finally {
    await setAll(page, frames, false);
  }
}
