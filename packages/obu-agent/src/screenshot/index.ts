// WS-E: Page.captureScreenshot (JPEG q70 default) scaled to <= maxWidth device
// pixels, written to a file; single-frame screencast fallback when capture hangs
// > 2 s (hidden tab). Images never travel as base64 in tool results.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScreenshotParams, ScreenshotResult } from "../contract.js";
import { ObuError } from "../errors.js";
import type { PageContext } from "../seams.js";
import { fnPageFocusState } from "../actions/page-fns.js";
import { callInFrame, elementCenter, mainFrame, resolveTarget, scrollIntoView, type ElementTarget } from "../actions/target.js";

export const CAPTURE_HANG_MS = 2000;
export const SCREENCAST_TIMEOUT_MS = 900;

interface LayoutMetrics {
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; zoom?: number };
  cssContentSize: { x: number; y: number; width: number; height: number };
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

let shotCounter = 0;

/** Pixel dimensions from a PNG / JPEG / WebP header. */
export function imageSize(buf: Buffer): { width: number; height: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    if (chunk === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return { width: 0, height: 0 };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const TIMEOUT = Symbol("timeout");

async function computeClip(page: PageContext, params: ScreenshotParams, dpr: number): Promise<{ clip: Clip; beyondViewport: boolean }> {
  const m = await page.cdp.send<LayoutMetrics>("Page.getLayoutMetrics");
  const vv = m.cssVisualViewport;
  let x = vv.pageX, y = vv.pageY, width = vv.clientWidth, height = vv.clientHeight;
  let beyondViewport = false;
  if (params.ref) {
    const target = (await resolveTarget(page, { ref: params.ref })) as ElementTarget;
    await scrollIntoView(page, target);
    const r = await page.cdp.send<{ quads: number[][] }>("DOM.getContentQuads", { objectId: target.objectId }, { sessionId: target.frame.sessionId })
      .catch(() => ({ quads: [] as number[][] }));
    if (!r.quads.length) throw new ObuError("not_actionable", `${params.ref} has no visible box to capture. Take a snapshot to check it is visible.`, { reason: "hidden", ref: params.ref });
    const xs = r.quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
    const ys = r.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
    const center = await elementCenter(page, target);
    // OOPIF quads are frame-local: shift by the same offset elementCenter applied.
    const localCx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const localCy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const dx = center ? center.x - localCx : 0;
    const dy = center ? center.y - localCy : 0;
    const margin = 8;
    // Re-read the viewport after scrolling.
    const m2 = await page.cdp.send<LayoutMetrics>("Page.getLayoutMetrics");
    x = m2.cssVisualViewport.pageX + Math.min(...xs) + dx - margin;
    y = m2.cssVisualViewport.pageY + Math.min(...ys) + dy - margin;
    width = Math.max(...xs) - Math.min(...xs) + margin * 2;
    height = Math.max(...ys) - Math.min(...ys) + margin * 2;
    x = Math.max(0, x);
    y = Math.max(0, y);
  } else if (params.fullPage) {
    x = 0;
    y = 0;
    width = m.cssContentSize.width;
    height = Math.min(m.cssContentSize.height, 16384);
    beyondViewport = true;
  }
  const maxWidth = params.maxWidth ?? 1280;
  const scale = Math.min(1, maxWidth / Math.max(1, width * dpr));
  return { clip: { x, y, width: Math.max(1, width), height: Math.max(1, height), scale }, beyondViewport };
}

async function screencastFrame(page: PageContext, format: "jpeg" | "png", quality: number, maxWidth: number, dpr: number): Promise<Buffer | null> {
  let resolveFrame!: (b: Buffer | null) => void;
  const got = new Promise<Buffer | null>((r) => (resolveFrame = r));
  const off = page.cdp.on("Page.screencastFrame", (p: { data: string; sessionId: number }, cdpSession?: string) => {
    if (cdpSession) return;
    void page.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
    resolveFrame(Buffer.from(p.data, "base64"));
  });
  try {
    await page.cdp.send("Page.startScreencast", { format, quality, maxWidth: Math.round(maxWidth / Math.max(dpr, 1)) * Math.max(dpr, 1), everyNthFrame: 1 });
    const r = await withTimeout(got, SCREENCAST_TIMEOUT_MS);
    return r === TIMEOUT ? null : r;
  } finally {
    off();
    await page.cdp.send("Page.stopScreencast").catch(() => undefined);
  }
}

export async function screenshot(page: PageContext, params: ScreenshotParams): Promise<ScreenshotResult> {
  const format = params.format ?? "jpeg";
  const quality = Math.max(1, Math.min(100, params.quality ?? 70));
  const maxWidth = params.maxWidth ?? 1280;
  const frame = await mainFrame(page);
  const dpr = (await callInFrame<ReturnType<typeof fnPageFocusState>>(page, frame, fnPageFocusState).catch(() => null))?.value?.dpr ?? 1;
  const { clip, beyondViewport } = await computeClip(page, params, dpr);

  const annotate = !!params.annotate;
  if (annotate) await page.callInjected(frame, "annotate", [true]).catch(() => undefined);
  let data: Buffer | null = null;
  let via: ScreenshotResult["via"] = "capture";
  try {
    const capture = page.cdp.send<{ data: string }>("Page.captureScreenshot", {
      format,
      ...(format === "png" ? {} : { quality }),
      clip,
      captureBeyondViewport: beyondViewport,
      fromSurface: true,
      optimizeForSpeed: true,
    });
    const r = await withTimeout(capture, CAPTURE_HANG_MS);
    if (r !== TIMEOUT) data = Buffer.from(r.data, "base64");
    else {
      capture.catch(() => undefined);
      via = "screencast";
      data = await screencastFrame(page, format === "png" ? "png" : "jpeg", quality, maxWidth, dpr);
    }
  } finally {
    if (annotate) await page.callInjected(frame, "annotate", [false]).catch(() => undefined);
  }
  if (!data) {
    throw new ObuError("timeout", "Screenshot timed out: the tab is not rendering (hidden or frozen). Take a snapshot instead, or retry after the page settles.", { stage: "screenshot" });
  }
  const ext = via === "screencast" && format === "webp" ? "jpeg" : format;
  const mime = `image/${ext}`;
  await mkdir(page.artifactDir, { recursive: true });
  const path = join(page.artifactDir, `screenshot-${Date.now()}-${++shotCounter}.${ext === "jpeg" ? "jpg" : ext}`);
  await writeFile(path, data);
  const { width, height } = imageSize(data);
  return { path, mime, width, height, via };
}
