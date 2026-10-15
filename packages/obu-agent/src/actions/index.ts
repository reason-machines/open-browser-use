// WS-E: element actions with actionability, hit test, CDP input and verify
// fallbacks (contract §Input), each wrapped in performActionAndWait (§Settle).
import type { ActParams, ActResult, NavigateParams, NavigateResult, Settled } from "../contract.js";
import { ObuError } from "../errors.js";
import type { PageContext } from "../seams.js";
import { keyEvents, modifierMask, press, typeText } from "../input/keys.js";
import { BUTTON_INDEX, mouseClick, mouseDrag, mouseMove, mouseWheel, type MouseButton, type Point } from "../input/mouse.js";
import { performActionAndWait, tabActivity } from "../wait/index.js";
import { downloadTracker, uploadFiles } from "../files/index.js";
import {
  fnBox, fnDomClick, fnDragDrop, fnFocusSelectAll, fnHitTest, fnPageFocusState, fnReadValue, fnReadiness, fnScroll,
  fnSelectOptions, fnSetValue, fnState, fnSynthPointer, fnVisibleLabel, type ElementState,
} from "./page-fns.js";
import {
  callInFrame, callOn, callOnForObject, callOnWithObjects, elementCenter, mainFrame, resolveTarget, scrollIntoView,
  type ElementTarget, type PointTarget, type Target,
} from "./target.js";

export { performActionAndWait } from "../wait/index.js";

const DEFAULT_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [0, 100, 200];
/** Stability: same box twice, 32 ms apart (timed in the daemon: page timers are throttled in background tabs). */
const STABLE_GAP_MS = 32;
const DISCLOSURE_VERIFY_MS = 80;
const VALUE_INPUT_TYPES = ["date", "time", "datetime-local", "month", "week", "color", "range"];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ActOutcome = Omit<ActResult, "events" | "snapshot">;

const NOT_ACTIONABLE_ADVICE: Record<string, string> = {
  detached: "is no longer in the page. Take a fresh snapshot and use the new ref.",
  hidden: "is not visible (inside a closed menu, collapsed section or another tab panel?). Open its container first, or snapshot to find a visible one.",
  disabled: "is disabled. Complete the fields it depends on first, then retry.",
  unstable: "kept moving (animation). Retry once the animation finishes.",
  not_editable: "is not an editable field. Target the input/textarea itself (snapshot shows it as textbox/combobox).",
};

interface Ready extends ElementState {
  state: "ok";
  rect: { x: number; y: number; width: number; height: number };
}

/**
 * Actionability: attached, visible, enabled (and editable when asked), stable
 * across 32 ms. Retries at 0/100/200 ms, then every 200 ms until the timeout.
 * Hidden checkbox/radio with a visible label returns `useLabel`.
 */
async function waitActionable(
  page: PageContext,
  target: ElementTarget,
  opts: { enabled?: boolean; editable?: boolean; visible?: boolean; timeoutMs: number },
): Promise<Ready | (ElementState & { useLabel: true })> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = "timeout";
  for (let attempt = 0; ; attempt++) {
    if (opts.visible !== false) await scrollIntoView(page, target);
    let st = await callOn<ElementState | { state: "unstable"; tag: string }>(page, target.frame, target.objectId, fnReadiness, [
      { enabled: opts.enabled ?? true, editable: opts.editable ?? false, stable: false },
    ]);
    if (st.state === "ok" && opts.visible !== false) {
      await sleep(STABLE_GAP_MS);
      const box2 = await callOn<string>(page, target.frame, target.objectId, fnBox);
      if (box2 !== (st as ElementState).box) st = { state: "unstable", tag: st.tag };
    }
    if (st.state === "ok" && (st as ElementState).rect) return st as Ready;
    if (opts.visible === false && st.state !== "detached") return { ...(st as ElementState), state: "ok", rect: { x: 0, y: 0, width: 0, height: 0 } } as Ready;
    if (st.state === "hidden" && (st as ElementState).isCheckable && (st as ElementState).hasVisibleLabel) return { ...(st as ElementState), useLabel: true };
    if (st.state === "detached") {
      throw new ObuError("stale_ref", `The ${target.label} ${NOT_ACTIONABLE_ADVICE.detached}`, { ref: target.ref, reason: "detached" });
    }
    last = st.state;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(RETRY_DELAYS_MS[attempt] ?? 200, Math.max(0, deadline - Date.now())));
  }
  throw new ObuError("not_actionable", `The ${target.label} ${NOT_ACTIONABLE_ADVICE[last] ?? `was not actionable within ${opts.timeoutMs} ms.`}`, { reason: last, ref: target.ref });
}

async function pageFocus(page: PageContext, target: Target): Promise<{ visible: boolean; focused: boolean }> {
  try {
    return (await callInFrame<{ visible: boolean; focused: boolean }>(page, target.frame, fnPageFocusState)).value;
  } catch {
    return { visible: true, focused: true };
  }
}

interface ClickOpts {
  button: MouseButton;
  clickCount: number;
  modifiers: number;
}

/** Click an element: point, hit test, CDP mouse, verify + fallbacks. */
async function clickElement(page: PageContext, target: ElementTarget, o: ClickOpts, timeoutMs: number, warnings: string[]): Promise<void> {
  const st = await waitActionable(page, target, { enabled: true, timeoutMs });
  if ("useLabel" in st) {
    const labelId = await callOnForObject(page, target.frame, target.objectId, fnVisibleLabel);
    if (!labelId) throw new ObuError("not_actionable", `The ${target.label} is hidden and has no visible label.`, { reason: "hidden", ref: target.ref });
    const before = await callOn<{ checked?: boolean | "mixed" }>(page, target.frame, target.objectId, fnState);
    await clickElement(page, { ...target, objectId: labelId, label: `label of ${target.label}` }, o, timeoutMs, warnings);
    const after = await callOn<{ checked?: boolean | "mixed" }>(page, target.frame, target.objectId, fnState);
    if (after.checked === before.checked && st.type === "checkbox") {
      await callOn(page, target.frame, target.objectId, fnDomClick);
      warnings.push("label click did not toggle the hidden checkbox; used a DOM click");
    }
    warnings.push("clicked the visible label of a hidden checkbox/radio");
    return;
  }
  const local = { x: st.rect.x + st.rect.width / 2, y: st.rect.y + st.rect.height / 2 };
  const point = (await elementCenter(page, target)) ?? local;
  const before = st.isCheckable || st.expanded === "false" ? await callOn<{ checked?: boolean | "mixed"; expanded: string | null }>(page, target.frame, target.objectId, fnState) : null;
  const hit = await callOn<{ ok: boolean; by?: string }>(page, target.frame, target.objectId, fnHitTest, [local.x, local.y]);
  if (!hit.ok) {
    if (o.button === "left" && o.modifiers === 0) {
      await callOn(page, target.frame, target.objectId, fnDomClick);
      if (o.clickCount === 2) await callOn(page, target.frame, target.objectId, function (this: Element) { this.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, detail: 2 })); });
      warnings.push(`fell back to a DOM click (obscured by ${hit.by ?? "another element"})`);
      return;
    }
    throw new ObuError("obscured", `The ${target.label} is covered by ${hit.by ?? "another element"}. Close the overlay/dialog first, or act on the covering element.`, { by: hit.by, ref: target.ref });
  }
  const f = await pageFocus(page, target);
  if (!f.visible) {
    // Hidden tab without focus emulation: Chrome drops CDP mouse/key input. Synthesize at the point.
    await callInFrame(page, target.frame, fnSynthPointer, [o.clickCount === 2 ? "dblclick" : "click", local.x, local.y, BUTTON_INDEX[o.button], o.modifiers, 0, 0]);
    warnings.push("tab is hidden: synthesized DOM pointer events on the element");
  } else {
    await mouseClick(page.cdp, point, o);
  }
  if (!before || o.button !== "left") return;
  // Verify: checkbox flipped; disclosure opened.
  if (st.isCheckable && st.type === "checkbox") {
    const after = await callOn<{ checked?: boolean | "mixed"; connected: boolean }>(page, target.frame, target.objectId, fnState);
    if (after.connected && after.checked === before.checked) {
      await callOn(page, target.frame, target.objectId, fnDomClick);
      warnings.push("checkbox did not toggle on mouse click; used a DOM click");
    }
  } else if (before.expanded === "false") {
    await sleep(DISCLOSURE_VERIFY_MS);
    const after = await callOn<{ expanded: string | null; connected: boolean }>(page, target.frame, target.objectId, fnState);
    if (after.connected && after.expanded === "false") {
      await callOn(page, target.frame, target.objectId, fnDomClick);
      warnings.push("disclosure stayed collapsed after the mouse click; used a DOM click");
    }
  }
}

/** Raw coordinate click/hover: CDP when the tab is visible + focused, else synthesized DOM events. */
async function pointAction(page: PageContext, t: PointTarget, kind: "click" | "dblclick" | "hover", o: ClickOpts, warnings: string[]): Promise<void> {
  const f = await pageFocus(page, t);
  if (!f.visible || !f.focused) {
    await callInFrame(page, t.frame, fnSynthPointer, [kind, t.point.x, t.point.y, BUTTON_INDEX[o.button], o.modifiers, 0, 0]);
    warnings.push("tab is in the background: synthesized DOM pointer events at the point");
    return;
  }
  if (kind === "hover") await mouseMove(page.cdp, t.point, o.modifiers);
  else await mouseClick(page.cdp, t.point, o);
}

async function focusElement(page: PageContext, target: ElementTarget, selectAll: boolean): Promise<void> {
  const ok = await callOn<boolean>(page, target.frame, target.objectId, fnFocusSelectAll, [selectAll]);
  if (!ok) {
    // Some widgets only take focus from a real click.
    const point = await elementCenter(page, target);
    if (point) await mouseClick(page.cdp, point, { button: "left", clickCount: 1, modifiers: 0 });
    if (selectAll) await callOn(page, target.frame, target.objectId, fnFocusSelectAll, [true]);
  }
}

/** Key events are dropped on hidden tabs; Input.insertText still works there (text exact, no key handlers). */
async function typeVisibleOrInsert(page: PageContext, t: Target, value: string, warnings: string[]): Promise<void> {
  if ((await pageFocus(page, t)).visible) return typeText(page.cdp, value);
  await page.cdp.send("Input.insertText", { text: value });
  warnings.push("tab is hidden: inserted the text without key events");
}

function normalizeText(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/ /g, " ").trim();
}

async function fillElement(page: PageContext, target: ElementTarget, value: string, timeoutMs: number, warnings: string[]): Promise<void> {
  const st = await waitActionable(page, target, { enabled: true, editable: false, timeoutMs });
  if ("useLabel" in st || st.isCheckable) throw new ObuError("invalid_params", `The ${target.label} is a checkbox/radio: use action "check" or "uncheck".`);
  if (st.isSelect) {
    await selectElement(page, target, [value]);
    warnings.push("fill on a <select>: selected the matching option");
    return;
  }
  if (st.isFileInput) throw new ObuError("invalid_params", `The ${target.label} is a file input: use action "upload" with absolute paths.`);
  if (!st.isEditable) {
    throw new ObuError("not_actionable", `The ${target.label} ${NOT_ACTIONABLE_ADVICE.not_editable}`, { reason: "not_editable", ref: target.ref });
  }
  if (st.tag === "input" && VALUE_INPUT_TYPES.includes(st.type ?? "")) {
    const got = await callOn<string>(page, target.frame, target.objectId, fnSetValue, [value]);
    if (got !== value) warnings.push(`the ${st.type} input normalised the value to "${got}"`);
    return;
  }
  await focusElement(page, target, true);
  if (value === "") await press(page.cdp, "Delete");
  else await page.cdp.send("Input.insertText", { text: value });
  const got = await callOn<string>(page, target.frame, target.objectId, fnReadValue);
  if (normalizeText(got) !== normalizeText(value)) {
    // Masked / controlled inputs: native setter + input/change.
    const forced = await callOn<string>(page, target.frame, target.objectId, fnSetValue, [value]);
    warnings.push(normalizeText(forced) === normalizeText(value)
      ? "typed text did not stick; set the value directly (check the field accepted it)"
      : `field shows "${forced.slice(0, 80)}" instead of the requested value (input mask or validation?)`);
  }
}

async function selectElement(page: PageContext, target: ElementTarget, values: string[]): Promise<string[]> {
  const r = await callOn<{ selected: string[] } | { error: string; options: string[] }>(page, target.frame, target.objectId, fnSelectOptions, [values]);
  if ("error" in r) {
    if (r.error === "not a <select>") {
      throw new ObuError("not_actionable", `The ${target.label} is not a native <select>. Click it to open the list, then click the option.`, { reason: "not_select", ref: target.ref });
    }
    throw new ObuError("invalid_params", `${r.error}. Options: ${r.options.join(" | ")}`);
  }
  return r.selected;
}

function clickOpts(params: ActParams, clickCount: number): ClickOpts {
  return { button: params.button ?? "left", clickCount, modifiers: modifierMask(params.modifiers) };
}

function valueList(v: ActParams["value"]): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

function valueString(v: ActParams["value"], action: string): string {
  if (v === undefined) throw new ObuError("invalid_params", `${action} needs \`value\`.`);
  return Array.isArray(v) ? v.join("") : String(v);
}

async function pointOf(page: PageContext, t: Target): Promise<Point> {
  if (t.kind === "point") return t.point;
  await scrollIntoView(page, t);
  const p = await elementCenter(page, t);
  if (!p) throw new ObuError("not_actionable", `The ${t.label} has no visible box.`, { reason: "hidden", ref: t.ref });
  return p;
}

/** Run one `act` call: resolve + actionability, then dispatch inside performActionAndWait. */
export async function act(page: PageContext, params: ActParams): Promise<ActOutcome> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Any action may start a download: track this tab's downloads from now on.
  downloadTracker(page);
  const warnings: string[] = [];
  const details: Record<string, unknown> = {};
  const hasTarget = params.ref !== undefined || params.selector !== undefined || params.coords !== undefined;
  const target = hasTarget ? await resolveTarget(page, params) : null;
  const needTarget = (): Target => {
    if (!target) throw new ObuError("invalid_params", `${params.action} needs a ref, selector or coords.`);
    return target;
  };
  const needElement = (): ElementTarget => {
    const t = needTarget();
    if (t.kind !== "element") throw new ObuError("invalid_params", `${params.action} needs a ref or selector, not coords.`);
    return t;
  };
  let run: () => Promise<void>;

  switch (params.action) {
    case "click":
    case "dblclick":
    case "hover": {
      const t = needTarget();
      const o = clickOpts(params, params.action === "dblclick" ? 2 : 1);
      if (t.kind === "point") {
        run = () => pointAction(page, t, params.action as "click" | "dblclick" | "hover", o, warnings);
      } else if (params.action === "hover") {
        const st = await waitActionable(page, t, { enabled: false, timeoutMs });
        if ("useLabel" in st) throw new ObuError("not_actionable", `The ${t.label} ${NOT_ACTIONABLE_ADVICE.hidden}`, { reason: "hidden", ref: t.ref });
        const local = { x: st.rect.x + st.rect.width / 2, y: st.rect.y + st.rect.height / 2 };
        const hit = await callOn<{ ok: boolean; by?: string }>(page, t.frame, t.objectId, fnHitTest, [local.x, local.y]);
        if (!hit.ok) throw new ObuError("obscured", `The ${t.label} is covered by ${hit.by ?? "another element"}; hover would land on it instead.`, { by: hit.by, ref: t.ref });
        const p = (await elementCenter(page, t)) ?? local;
        run = async () => {
          if ((await pageFocus(page, t)).visible) await mouseMove(page.cdp, p, o.modifiers);
          else {
            await callInFrame(page, t.frame, fnSynthPointer, ["hover", local.x, local.y, 0, o.modifiers, 0, 0]);
            warnings.push("tab is hidden: synthesized DOM hover events");
          }
        };
      } else {
        run = () => clickElement(page, t, o, timeoutMs, warnings);
      }
      break;
    }
    case "fill": {
      const t = needElement();
      const value = valueString(params.value ?? "", "fill");
      run = () => fillElement(page, t, value, timeoutMs, warnings);
      break;
    }
    case "type": {
      const value = valueString(params.value, "type");
      if (target) {
        const t = needElement();
        const st = await waitActionable(page, t, { enabled: true, editable: true, timeoutMs });
        if ("useLabel" in st) throw new ObuError("not_actionable", `The ${t.label} ${NOT_ACTIONABLE_ADVICE.not_editable}`, { reason: "not_editable" });
        run = async () => {
          await focusElement(page, t, false);
          await typeVisibleOrInsert(page, t, value, warnings);
        };
      } else {
        run = async () => typeVisibleOrInsert(page, { kind: "point", frame: await mainFrame(page), point: { x: 0, y: 0 }, label: "page" }, value, warnings);
      }
      break;
    }
    case "press": {
      const keys = params.keys ?? (typeof params.value === "string" ? params.value : undefined);
      if (!keys) throw new ObuError("invalid_params", "press needs `keys`, e.g. \"Enter\", \"Escape\", \"ControlOrMeta+A\".");
      const combos = keys.split(/\s+/).filter(Boolean);
      for (const c of combos) keyEvents(c); // validate before acting
      const t = target ? needElement() : null;
      run = async () => {
        if (t) {
          await waitActionable(page, t, { enabled: true, timeoutMs });
          await focusElement(page, t, false);
        }
        if (!(await pageFocus(page, t ?? { kind: "point", frame: await mainFrame(page), point: { x: 0, y: 0 }, label: "page" })).visible) {
          warnings.push("tab is hidden: Chrome may ignore key presses until it is visible (WS-C focus emulation)");
        }
        for (const c of combos) await press(page.cdp, c);
      };
      break;
    }
    case "select": {
      const t = needElement();
      const values = valueList(params.value);
      if (!values.length) throw new ObuError("invalid_params", "select needs `value`: option value(s) or label(s).");
      await waitActionable(page, t, { enabled: true, timeoutMs });
      run = async () => { details.selected = await selectElement(page, t, values); };
      break;
    }
    case "check":
    case "uncheck": {
      const t = needElement();
      const want = params.action === "check";
      run = async () => {
        const st = await callOn<ElementState>(page, t.frame, t.objectId, fnReadiness, [{ enabled: false, editable: false, stable: false }]);
        if (!st.isCheckable) throw new ObuError("invalid_params", `The ${t.label} is not a checkbox, radio or switch.`);
        if (st.checked === want) { warnings.push(`already ${want ? "checked" : "unchecked"}`); return; }
        if (!want && st.type === "radio") throw new ObuError("invalid_params", "A radio button cannot be unchecked; check another option instead.");
        await clickElement(page, t, { button: "left", clickCount: 1, modifiers: 0 }, timeoutMs, warnings);
        const after = await callOn<{ checked?: boolean | "mixed" }>(page, t.frame, t.objectId, fnState);
        if (after.checked !== want) {
          await callOn(page, t.frame, t.objectId, fnDomClick);
          const again = await callOn<{ checked?: boolean | "mixed" }>(page, t.frame, t.objectId, fnState);
          if (again.checked !== want) throw new ObuError("not_actionable", `The ${t.label} did not change state (the page may block it).`, { reason: "unchanged", ref: t.ref });
          warnings.push("mouse click did not change the state; used a DOM click");
        }
      };
      break;
    }
    case "drag": {
      const src = needTarget();
      if (!params.to) throw new ObuError("invalid_params", "drag needs `to` ({ref}|{selector}|{coords}).");
      const dst = await resolveTarget(page, params.to, "drop target");
      let html5 = false;
      if (src.kind === "element") {
        const st = await waitActionable(page, src, { enabled: true, timeoutMs });
        html5 = !("useLabel" in st) && st.draggable && dst.kind === "element" && dst.frame.frameId === src.frame.frameId;
      }
      if (html5) {
        run = async () => {
          const r = await callOnWithObjects<{ dropped: boolean }>(page, src.frame, (src as ElementTarget).objectId, fnDragDrop, [(dst as ElementTarget).objectId]);
          details.dropped = r.dropped;
        };
      } else {
        const from = await pointOf(page, src);
        const to = await pointOf(page, dst);
        run = () => mouseDrag(page.cdp, from, to, 10, modifierMask(params.modifiers));
      }
      break;
    }
    case "upload": {
      const t = needElement();
      if (!params.files?.length) throw new ObuError("invalid_params", "upload needs `files`: absolute local paths.");
      const st = await waitActionable(page, t, { enabled: true, visible: false, timeoutMs });
      run = async () => {
        const r = await uploadFiles(page, t, params.files!, {
          isFileInput: st.isFileInput,
          clickToOpen: () => clickElement(page, t, { button: "left", clickCount: 1, modifiers: 0 }, timeoutMs, warnings),
        });
        details.upload = { mode: r.mode, files: r.files };
        warnings.push(...r.warnings);
      };
      break;
    }
    case "scroll": {
      const direction = (typeof params.value === "string" ? params.value : "down").toLowerCase();
      if (!["up", "down", "left", "right"].includes(direction)) throw new ObuError("invalid_params", "scroll `value` must be up, down, left or right.");
      if (target?.kind === "point") {
        const t = target;
        const dy = direction === "down" ? 600 : direction === "up" ? -600 : 0;
        const dx = direction === "right" ? 600 : direction === "left" ? -600 : 0;
        run = async () => {
          const f = await pageFocus(page, t);
          if (!f.visible) await callInFrame(page, t.frame, fnSynthPointer, ["wheel", t.point.x, t.point.y, 0, 0, dx, dy]);
          else await mouseWheel(page.cdp, t.point, dx, dy);
        };
      } else if (target) {
        const t = needElement();
        run = async () => { details.scroll = await callOn(page, t.frame, t.objectId, fnScroll, [direction, 0.8]); };
      } else {
        run = async () => { details.scroll = (await callInFrame(page, await mainFrame(page), fnScroll, [direction, 0.8])).value; };
      }
      break;
    }
    default:
      throw new ObuError("invalid_params", `Unknown action "${String(params.action)}".`);
  }

  const settled = await performActionAndWait(page, run);
  return {
    ok: true,
    settled,
    ...(warnings.length ? { warnings } : {}),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

/** navigate: url | back | forward | reload, then settle (waitUntil default 'settled'). */
export async function navigate(page: PageContext, params: NavigateParams): Promise<Omit<NavigateResult, "events" | "snapshot">> {
  const warnings: string[] = [];
  if (!params.url && !params.op) throw new ObuError("invalid_params", "navigate needs `url` or `op` (back | forward | reload).");
  const activity = tabActivity(page.cdp);
  await activity.ensureEnabled();
  downloadTracker(page);
  const run = async () => {
    if (params.url) {
      const r = await page.cdp.send<{ errorText?: string }>("Page.navigate", { url: params.url });
      if (r.errorText) warnings.push(`navigation error: ${r.errorText}`);
    } else if (params.op === "reload") {
      await page.cdp.send("Page.reload", {});
    } else {
      const h = await page.cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
      const idx = h.currentIndex + (params.op === "back" ? -1 : 1);
      const entry = h.entries[idx];
      if (!entry) throw new ObuError("invalid_params", `Cannot go ${params.op}: no history entry.`);
      await page.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    }
  };
  const waitUntil = params.waitUntil ?? "settled";
  let settled: Settled;
  if (waitUntil === "settled") {
    settled = await performActionAndWait(page, run);
  } else {
    const started = Date.now();
    const event = waitUntil === "load" ? "Page.loadEventFired" : waitUntil === "domcontentloaded" ? "Page.domContentEventFired" : null;
    let off: (() => void) | undefined;
    const fired = event ? new Promise<void>((r) => { off = page.cdp.on(event, (_p: unknown, s?: string) => { if (!s) r(); }); }) : Promise.resolve();
    await run();
    const timedOut = await Promise.race([fired.then(() => false), sleep(8000).then(() => true)]);
    off?.();
    settled = { kind: "nav", ms: Date.now() - started, ...(timedOut ? { warning: `${waitUntil} did not fire within 8000 ms` } : {}) };
  }
  if (settled.warning) warnings.push(settled.warning);
  return { ok: true, settled, ...(warnings.length ? { warnings } : {}) };
}
