// WS-E: Page.captureScreenshot JPEG q70 scaled to <=1280 wide, written to a file;
// screencast single-frame fallback when capture hangs > 2 s.
import type { ScreenshotParams, ScreenshotResult } from "../contract.js";
import { notImplemented } from "../errors.js";
import type { PageContext } from "../seams.js";

export async function screenshot(_page: PageContext, _params: ScreenshotParams): Promise<ScreenshotResult> {
  throw notImplemented("screenshot", "WS-E");
}
