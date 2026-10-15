// WS-E: CDP mouse input (Input.dispatchMouseEvent) in main-frame viewport
// coordinates. OOPIF targets are dispatched on the tab's main session with the
// iframe offset already added by the caller.
import type { TabCdp } from "../seams.js";

export type MouseButton = "left" | "right" | "middle";

const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };
export const BUTTON_INDEX: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };

export interface Point {
  x: number;
  y: number;
}

export async function mouseMove(cdp: TabCdp, p: Point, modifiers = 0): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, modifiers, button: "none", buttons: 0 });
}

/** moved -> (pressed, released) x clickCount. */
export async function mouseClick(cdp: TabCdp, p: Point, opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
  const button = opts.button ?? "left";
  const modifiers = opts.modifiers ?? 0;
  const count = opts.clickCount ?? 1;
  await mouseMove(cdp, p, modifiers);
  for (let c = 1; c <= count; c++) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, modifiers, button, buttons: BUTTON_BITS[button], clickCount: c });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, modifiers, button, buttons: 0, clickCount: c });
  }
}

/** Press at `from`, move in steps, release at `to` (pointer-driven drag libraries). */
export async function mouseDrag(cdp: TabCdp, from: Point, to: Point, steps = 8, modifiers = 0): Promise<void> {
  await mouseMove(cdp, from, modifiers);
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, modifiers, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers, button: "left", buttons: 1 });
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, modifiers, button: "left", buttons: 0, clickCount: 1 });
}

export async function mouseWheel(cdp: TabCdp, p: Point, deltaX: number, deltaY: number, modifiers = 0): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y, deltaX, deltaY, modifiers, button: "none", buttons: 0 });
}
