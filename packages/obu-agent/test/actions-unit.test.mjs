// WS-E unit tests (no browser): key mapping, Mac editing commands, screenshot
// hang -> screencast fallback, image size parsing, settle cap warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyEvents, parseShortcut, modifierMask } from "../dist/input/keys.js";
import { screenshot, imageSize } from "../dist/screenshot/index.js";
import { performActionAndWait } from "../dist/wait/index.js";

test("ControlOrMeta maps per platform; Mac editing commands attach to Cmd shortcuts", () => {
  assert.deepEqual(parseShortcut("ControlOrMeta+A", true), { modifiers: ["Meta"], key: "a" });
  assert.deepEqual(parseShortcut("ControlOrMeta+A", false), { modifiers: ["Control"], key: "a" });
  const mac = keyEvents("ControlOrMeta+A", true);
  assert.deepEqual(mac.map((e) => e.type), ["rawKeyDown", "rawKeyDown", "keyUp", "keyUp"]);
  assert.deepEqual(mac[1].commands, ["selectAll"]);
  assert.equal(mac[1].modifiers, 4);
  assert.equal(mac[1].text, undefined, "no text with Meta held");
  assert.deepEqual(keyEvents("Meta+Shift+Z", true).find((e) => e.commands)?.commands, ["redo"]);
  assert.equal(keyEvents("Control+A", false).some((e) => e.commands), false);
  for (const [k, cmd] of [["Meta+C", "copy"], ["Meta+V", "paste"], ["Meta+X", "cut"], ["Meta+Z", "undo"]]) {
    assert.deepEqual(keyEvents(k, true).find((e) => e.commands)?.commands, [cmd]);
  }
});

test("named keys, shifted characters, plus key and unknown keys", () => {
  const enter = keyEvents("Enter", true);
  assert.equal(enter[0].type, "keyDown");
  assert.equal(enter[0].text, "\r");
  assert.equal(enter[0].windowsVirtualKeyCode, 13);
  const shiftA = keyEvents("Shift+a", true);
  assert.equal(shiftA[1].key, "A");
  assert.equal(shiftA[1].text, "A");
  assert.deepEqual(parseShortcut("Shift++", true), { modifiers: ["Shift"], key: "+" });
  assert.deepEqual(parseShortcut("+", true), { modifiers: [], key: "+" });
  assert.equal(keyEvents("é", true)[0].text, "é");
  assert.throws(() => keyEvents("Hyper+A", true), (e) => e.code === "invalid_params");
  assert.throws(() => keyEvents("NotAKey", true), (e) => e.code === "invalid_params");
  assert.equal(modifierMask(["Alt", "Shift"]), 9);
});

function fakePage({ captureHangs = false, frames = [] } = {}) {
  const handlers = new Map();
  const sent = [];
  const artifactDir = mkdtempSync(join(tmpdir(), "obu-wse-unit-"));
  // 1x1 JPEG header-ish buffer with SOF0 (width 3, height 2).
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const cdp = {
    tabId: 1,
    targetId: "T",
    async send(method, params) {
      sent.push(method);
      switch (method) {
        case "Page.getLayoutMetrics":
          return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1440, clientHeight: 900 }, cssContentSize: { x: 0, y: 0, width: 1440, height: 3000 } };
        case "Page.captureScreenshot":
          if (captureHangs) return new Promise(() => {});
          return { data: jpeg.toString("base64") };
        case "Page.startScreencast":
          setTimeout(() => handlers.get("Page.screencastFrame")?.({ data: jpeg.toString("base64"), sessionId: 7 }), 20);
          return {};
        case "Runtime.callFunctionOn":
          return { result: { type: "object", value: { visible: false, focused: false, dpr: 2 } } };
        default:
          return {};
      }
    },
    on(event, h) {
      handlers.set(event, h);
      return () => handlers.delete(event);
    },
  };
  return {
    sent,
    cleanup: () => rmSync(artifactDir, { recursive: true, force: true }),
    page: {
      sessionId: "s", cdp, artifactDir,
      frames: async () => (frames.length ? frames : [{ ordinal: 0, frameId: "T", utilityContextId: 1, origin: "x" }]),
      callInjected: async () => { throw new Error("no __obu"); },
      resolveRef: async () => null,
      emit() {},
    },
  };
}

test("screenshot falls back to a screencast frame when capture hangs (< 3 s)", async () => {
  const f = fakePage({ captureHangs: true });
  const t0 = Date.now();
  const s = await screenshot(f.page, {});
  const ms = Date.now() - t0;
  assert.equal(s.via, "screencast");
  assert.ok(ms >= 2000 && ms < 3000, `took ${ms}`);
  assert.deepEqual([s.width, s.height], [3, 2]);
  assert.ok(f.sent.includes("Page.stopScreencast") && f.sent.includes("Page.screencastFrameAck"));
  f.cleanup();
});

test("screenshot clip scales to maxWidth in device pixels", async () => {
  const f = fakePage();
  let clip;
  const orig = f.page.cdp.send;
  f.page.cdp.send = async (m, p) => { if (m === "Page.captureScreenshot") clip = p.clip; return orig(m, p); };
  await screenshot(f.page, { maxWidth: 1440 });
  assert.equal(clip.scale, 0.5, "1440 css px at dpr 2 -> 0.5 scale for 1440 device px");
  f.cleanup();
});

test("imageSize parses PNG and WebP headers", () => {
  const png = Buffer.alloc(32);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(imageSize(png), { width: 640, height: 480 });
  const webp = Buffer.alloc(32);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8 ", 12, "ascii");
  webp.writeUInt16LE(800, 26);
  webp.writeUInt16LE(600, 28);
  assert.deepEqual(imageSize(webp), { width: 800, height: 600 });
});

test("settle is capped: a never-ready navigation returns a warning, not an error", async () => {
  const f = fakePage();
  // Navigation starts and never finishes; probes return a loading page.
  f.page.cdp.send = async (m) => (m === "Runtime.callFunctionOn" ? { result: { type: "object", value: { readyState: "loading", interactiveCount: 0, textLen: 0, landmarks: 0, mutationRatio: 0, mutations: 0, nodes: 1, url: "x" } } } : {});
  const handlers = new Map();
  f.page.cdp.on = (e, h) => { handlers.set(e, h); return () => {}; };
  const settled = await performActionAndWait(f.page, async () => {
    handlers.get("Page.frameStartedLoading")?.({ frameId: "T" });
    handlers.get("Page.frameNavigated")?.({ frame: { id: "T", url: "http://x/" } });
  }, { capMs: 600 });
  assert.equal(settled.kind, "nav");
  assert.match(settled.warning, /600 ms/);
  assert.ok(settled.ms >= 550 && settled.ms < 1200, `ms ${settled.ms}`);
  f.cleanup();
});
