// WS-E: resolving act targets (ref | selector | coords) and running page
// functions against them in the utility world.
import type { Coords, Ref } from "../contract.js";
import { ObuError } from "../errors.js";
import type { FrameHandle, PageContext } from "../seams.js";
import type { Point } from "../input/mouse.js";
import { fnQuery } from "./page-fns.js";

export interface ElementTarget {
  kind: "element";
  frame: FrameHandle;
  objectId: string;
  /** For error messages. */
  label: string;
  ref?: Ref;
}
export interface PointTarget {
  kind: "point";
  frame: FrameHandle;
  /** Main-frame viewport coordinates. */
  point: Point;
  label: string;
}
export type Target = ElementTarget | PointTarget;

type AnyFn = (this: any, ...args: any[]) => unknown;

interface RemoteObject {
  type: string;
  subtype?: string;
  value?: unknown;
  objectId?: string;
  description?: string;
}
interface CallResult {
  result: RemoteObject;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function fnSource(fn: AnyFn): string {
  const src = fn.toString();
  // Methods compiled as `function name(...)` are fine; guard against shorthand.
  return src.startsWith("function") || src.startsWith("async function") ? src : `function ${src}`;
}

function exceptionText(r: CallResult): string {
  return r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? "page function threw";
}

function isContextGone(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Cannot find context|Execution context was destroyed|Could not find object|No node with given id|Inspected target navigated|Node is detached|Cannot find object/i.test(msg);
}

/** Call a page function with `this` = element. Returns the by-value result. */
export async function callOn<T>(page: PageContext, frame: FrameHandle, objectId: string, fn: AnyFn, args: unknown[] = [], opts: { timeoutMs?: number } = {}): Promise<T> {
  let r: CallResult;
  try {
    r = await page.cdp.send<CallResult>(
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration: fnSource(fn), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true },
      { sessionId: frame.sessionId, timeoutMs: opts.timeoutMs },
    );
  } catch (err) {
    if (isContextGone(err)) throw new ObuError("stale_ref", "The element is gone (the page navigated or re-rendered). Take a fresh snapshot and use the new ref.");
    throw err;
  }
  if (r.exceptionDetails) throw new ObuError("internal", `Page function failed: ${exceptionText(r)}`);
  return r.result.value as T;
}

/** Call a page function with `this` = element and remote-object arguments; returns an objectId (or null). */
export async function callOnForObject(page: PageContext, frame: FrameHandle, objectId: string, fn: AnyFn, objectArgs: string[] = []): Promise<string | null> {
  const r = await page.cdp.send<CallResult>(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fnSource(fn), arguments: objectArgs.map((id) => ({ objectId: id })), returnByValue: false, awaitPromise: true },
    { sessionId: frame.sessionId },
  );
  if (r.exceptionDetails) throw new ObuError("internal", `Page function failed: ${exceptionText(r)}`);
  return r.result.subtype === "null" || r.result.type === "undefined" ? null : (r.result.objectId ?? null);
}

/** Call a page function with remote-object arguments, by value. */
export async function callOnWithObjects<T>(page: PageContext, frame: FrameHandle, objectId: string, fn: AnyFn, objectArgs: string[]): Promise<T> {
  const r = await page.cdp.send<CallResult>(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fnSource(fn), arguments: objectArgs.map((id) => ({ objectId: id })), returnByValue: true, awaitPromise: true, userGesture: true },
    { sessionId: frame.sessionId },
  );
  if (r.exceptionDetails) throw new ObuError("internal", `Page function failed: ${exceptionText(r)}`);
  return r.result.value as T;
}

/** Call a page function in a frame's utility world (no `this`). */
export async function callInFrame<T>(page: PageContext, frame: FrameHandle, fn: AnyFn, args: unknown[] = [], opts: { returnByValue?: boolean; timeoutMs?: number } = {}): Promise<{ value: T; objectId?: string; isNull: boolean }> {
  const r = await page.cdp.send<CallResult>(
    "Runtime.callFunctionOn",
    {
      executionContextId: frame.utilityContextId,
      functionDeclaration: fnSource(fn),
      arguments: args.map((value) => ({ value })),
      returnByValue: opts.returnByValue ?? true,
      awaitPromise: true,
      userGesture: true,
    },
    { sessionId: frame.sessionId, timeoutMs: opts.timeoutMs },
  );
  if (r.exceptionDetails) throw new ObuError("internal", `Page function failed: ${exceptionText(r)}`);
  return { value: r.result.value as T, objectId: r.result.objectId, isNull: r.result.subtype === "null" || r.result.type === "undefined" };
}

export async function mainFrame(page: PageContext): Promise<FrameHandle> {
  const frames = await page.frames();
  if (!frames.length) throw new ObuError("internal", "No frames available for this tab (still attaching?). Retry the call.");
  return frames[0];
}

/** Resolve exactly one of ref | selector | coords. */
export async function resolveTarget(page: PageContext, t: { ref?: Ref; selector?: string; coords?: Coords }, what = "target"): Promise<Target> {
  const given = [t.ref !== undefined, t.selector !== undefined, t.coords !== undefined].filter(Boolean).length;
  if (given !== 1) throw new ObuError("invalid_params", `Give exactly one of ref, selector or coords for the ${what}.`);
  if (t.ref !== undefined) {
    const resolved = await page.resolveRef(t.ref);
    if (!resolved) {
      throw new ObuError("stale_ref", `Ref ${t.ref} no longer resolves. Take a fresh snapshot and use the new ref.`, { ref: t.ref });
    }
    return { kind: "element", frame: resolved.frame, objectId: resolved.objectId, label: `ref ${t.ref}`, ref: t.ref };
  }
  if (t.selector !== undefined) {
    const frame = await mainFrame(page);
    const r = await callInFrame<null>(page, frame, fnQuery, [t.selector], { returnByValue: false });
    if (r.isNull || !r.objectId) {
      throw new ObuError("not_actionable", `No element matches selector "${t.selector}". Take a snapshot and act by ref instead.`, { reason: "detached" });
    }
    return { kind: "element", frame, objectId: r.objectId, label: `selector "${t.selector}"` };
  }
  const c = t.coords!;
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) throw new ObuError("invalid_params", "coords must be finite numbers {x, y} in viewport CSS pixels.");
  return { kind: "point", frame: await mainFrame(page), point: { x: c.x, y: c.y }, label: `point (${c.x}, ${c.y})` };
}

/**
 * Offset of a frame's viewport inside the main-frame viewport. Same-process
 * frames report root coordinates from DOM.getContentQuads already, so only
 * OOPIFs (frames with a child session) need their owner's content box.
 */
export async function frameOffset(page: PageContext, frame: FrameHandle): Promise<Point> {
  if (!frame.sessionId || frame.ordinal === 0) return { x: 0, y: 0 };
  try {
    const owner = await page.cdp.send<{ backendNodeId: number }>("DOM.getFrameOwner", { frameId: frame.frameId });
    const box = await page.cdp.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
    return { x: box.model.content[0], y: box.model.content[1] };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** Centre of the element's first content quad, in main-frame viewport coordinates. */
export async function elementCenter(page: PageContext, target: ElementTarget): Promise<Point | null> {
  let quads: number[][];
  try {
    const r = await page.cdp.send<{ quads: number[][] }>("DOM.getContentQuads", { objectId: target.objectId }, { sessionId: target.frame.sessionId });
    quads = r.quads;
  } catch (err) {
    if (isContextGone(err)) throw new ObuError("stale_ref", `The ${target.label} is gone. Take a fresh snapshot and use the new ref.`, { ref: target.ref });
    return null;
  }
  const area = (q: number[]) => Math.abs((q[0] * q[3] - q[1] * q[2]) + (q[2] * q[5] - q[3] * q[4]) + (q[4] * q[7] - q[5] * q[6]) + (q[6] * q[1] - q[7] * q[0])) / 2;
  const q = quads.find((x) => area(x) > 1);
  if (!q) return null;
  const local = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  const off = await frameOffset(page, target.frame);
  return { x: local.x + off.x, y: local.y + off.y };
}

export async function scrollIntoView(page: PageContext, target: ElementTarget): Promise<void> {
  try {
    await page.cdp.send("DOM.scrollIntoViewIfNeeded", { objectId: target.objectId }, { sessionId: target.frame.sessionId });
  } catch (err) {
    if (isContextGone(err)) throw new ObuError("stale_ref", `The ${target.label} is gone. Take a fresh snapshot and use the new ref.`, { ref: target.ref });
    // Elements without layout (display:contents etc.) — actionability reports the real reason.
  }
}
