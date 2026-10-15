// WS-D: toggle the set-of-marks overlay in every frame around a screenshot.
import type { PageContext } from "../seams.js";

export async function withAnnotations<T>(_page: PageContext, fn: () => Promise<T>): Promise<T> {
  return fn();
}
