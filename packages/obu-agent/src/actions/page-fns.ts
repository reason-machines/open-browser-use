// WS-E: functions that run inside the page (isolated utility world) via
// Runtime.callFunctionOn. Each one must be self-contained: no imports, no
// closures, no helpers outside its own body — it is shipped with
// Function.prototype.toString().
//
// They take the element as `this` (callFunctionOn with the element objectId),
// so they work the same for ref, selector and coordinate targets and do not
// depend on the WS-D bundle being present.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ElementState {
  state: "ok" | "detached" | "hidden" | "disabled" | "not_editable";
  /** Frame-local viewport rect of the click point region (visible part). */
  rect?: { x: number; y: number; width: number; height: number };
  tag: string;
  type?: string;
  checked?: boolean | "mixed";
  expanded?: string | null;
  isCheckable: boolean;
  isSelect: boolean;
  isFileInput: boolean;
  isEditable: boolean;
  isContentEditable: boolean;
  /** For hidden checkbox/radio: a visible label exists to click instead. */
  hasVisibleLabel: boolean;
  draggable: boolean;
  role?: string | null;
  name?: string;
  value?: string;
  /** getBoundingClientRect() as "x,y,w,h" (stability check). */
  box?: string;
}

/**
 * Actionability sample. With `stable`, samples twice 32 ms apart in-page
 * (setTimeout); the daemon normally passes stable:false and times the second
 * sample itself with fnBox, because background tabs throttle page timers
 * (~130 ms for a 32 ms timeout).
 */
export function fnReadiness(
  this: Element,
  opts: { enabled: boolean; editable: boolean; stable: boolean },
): Promise<ElementState | { state: "unstable"; tag: string }> {
  const el = this as HTMLElement;
  const describe = (): ElementState => {
    const tag = el.tagName ? el.tagName.toLowerCase() : "#node";
    const input = el as HTMLInputElement;
    const type = tag === "input" ? (input.type || "text").toLowerCase() : undefined;
    const isCheckable = (tag === "input" && (type === "checkbox" || type === "radio")) || ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(el.getAttribute?.("role") ?? "");
    const isSelect = tag === "select";
    const isFileInput = tag === "input" && type === "file";
    const textTypes = ["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week", "color", "range"];
    const isContentEditable = !!el.isContentEditable;
    const readOnly = (el as HTMLInputElement).readOnly === true;
    const isEditable = isContentEditable || (tag === "textarea" && !readOnly) || (tag === "input" && textTypes.includes(type ?? "text") && !readOnly);
    const ariaChecked = el.getAttribute?.("aria-checked");
    const checked: boolean | "mixed" | undefined = tag === "input" && (type === "checkbox" || type === "radio")
      ? (input.indeterminate ? "mixed" : input.checked)
      : ariaChecked === "mixed" ? "mixed" : ariaChecked === "true" ? true : ariaChecked === "false" ? false : undefined;
    const base: ElementState = {
      state: "ok",
      tag,
      type,
      checked,
      expanded: el.getAttribute?.("aria-expanded") ?? null,
      isCheckable,
      isSelect,
      isFileInput,
      isEditable,
      isContentEditable,
      hasVisibleLabel: false,
      draggable: el.draggable === true || tag === "img" || (tag === "a" && !!(el as HTMLAnchorElement).href),
      role: el.getAttribute?.("role"),
      name: (el.getAttribute?.("aria-label") || (el.textContent || "").trim()).slice(0, 80),
      value: "value" in el ? String((el as HTMLInputElement).value ?? "") : undefined,
    };
    if (!el.isConnected) return { ...base, state: "detached" };
    const visible = (node: Element): boolean => {
      const anyNode = node as any;
      if (typeof anyNode.checkVisibility === "function" && !anyNode.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })) return false;
      const rects = node.getClientRects();
      for (let i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) return true;
      return false;
    };
    if (isCheckable && tag === "input") {
      const labels = (input.labels ? Array.from(input.labels) : []) as Element[];
      const parentLabel = el.closest("label");
      if (parentLabel && !labels.includes(parentLabel)) labels.push(parentLabel);
      base.hasVisibleLabel = labels.some((l) => visible(l));
    }
    if (!visible(el)) return { ...base, state: "hidden" };
    if (opts.enabled) {
      let disabled = false;
      try { disabled = el.matches(":disabled"); } catch { /* not a form element */ }
      for (let n: Element | null = el; n && !disabled; n = n.parentElement) if (n.getAttribute("aria-disabled") === "true") disabled = true;
      if (disabled) return { ...base, state: "disabled" };
    }
    if (opts.editable && !isEditable) return { ...base, state: "not_editable" };
    // Visible part of the first non-empty client rect, clamped to the frame viewport.
    const rects = el.getClientRects();
    let r: DOMRect | undefined;
    for (let i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) { r = rects[i]; break; }
    if (!r) return { ...base, state: "hidden" };
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = document.documentElement.clientHeight || innerHeight;
    const x1 = Math.max(r.left, 0), y1 = Math.max(r.top, 0);
    const x2 = Math.min(r.right, vw), y2 = Math.min(r.bottom, vh);
    base.rect = x2 > x1 && y2 > y1
      ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
      : { x: r.left, y: r.top, width: r.width, height: r.height };
    const b = el.getBoundingClientRect();
    base.box = `${b.x},${b.y},${b.width},${b.height}`;
    return base;
  };
  const first = describe();
  if (!opts.stable || first.state !== "ok") return Promise.resolve(first);
  const box = (): string => { const b = el.getBoundingClientRect(); return `${b.x},${b.y},${b.width},${b.height}`; };
  const before = box();
  return new Promise((resolve) => {
    setTimeout(() => {
      if (box() !== before) resolve({ state: "unstable", tag: first.tag });
      else resolve(describe());
    }, 32);
  });
}

/** Bounding box as "x,y,w,h" (second stability sample, timed by the daemon). */
export function fnBox(this: Element): string {
  const b = this.getBoundingClientRect();
  return `${b.x},${b.y},${b.width},${b.height}`;
}

/** Hit test at a frame-local point, piercing open shadow roots. */
export function fnHitTest(this: Element, x: number, y: number): { ok: boolean; by?: string } {
  const target = this;
  let root: Document | ShadowRoot = document;
  let hit: Element | null = null;
  for (let i = 0; i < 32; i++) {
    const next: Element | null = root.elementFromPoint(x, y);
    if (!next || next === hit) break;
    hit = next;
    if (next.shadowRoot) root = next.shadowRoot; else break;
  }
  if (!hit) return { ok: false, by: "nothing (point outside the viewport)" };
  // Composed ancestry: is hit inside target (crossing shadow boundaries)?
  for (let n: Node | null = hit; n; n = (n as any).assignedSlot ?? n.parentNode ?? ((n as ShadowRoot).host || null)) {
    if (n === target) return { ok: true };
  }
  // Clicking the label of a control counts as hitting the control.
  const asInput = target as HTMLInputElement;
  if (asInput.labels) for (const l of Array.from(asInput.labels)) if (l === hit || l.contains(hit)) return { ok: true };
  const role = hit.getAttribute("role");
  const label = hit.getAttribute("aria-label") || (hit.textContent || "").trim().slice(0, 40);
  const id = hit.id ? `#${hit.id}` : "";
  return { ok: false, by: `${role ?? hit.tagName.toLowerCase()}${id}${label ? ` "${label}"` : ""}` };
}

/**
 * ARIA 1.1 combobox wrappers (`div[role=combobox]` around an `<input>`): users click the
 * text field, and the widget opens on its focus/input — clicking the wrapper's centre
 * usually lands on empty space. Retarget to the editable descendant.
 */
export function fnComboboxEditable(this: Element): Element | null {
  const el = this as HTMLElement;
  if (el.getAttribute("role") !== "combobox") return null;
  if (el.matches("input, textarea, [contenteditable=''], [contenteditable=true]")) return null;
  return el.querySelector("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true], [role=textbox], [role=searchbox]");
}

/** DOM click fallback (obscured element, unfocused tab, failed verify). */
export function fnDomClick(this: Element): void {
  const el = this as HTMLElement;
  // A real click focuses focusable targets before the click event; el.click() does not.
  if (el.matches("input, textarea, select, button, [contenteditable=''], [contenteditable=true], [tabindex]") && document.activeElement !== el) {
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
  }
  if (typeof el.click === "function") { el.click(); return; }
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: window }));
}

/** State snapshot used to verify clicks (checkbox flipped, disclosure opened). */
export function fnState(this: Element): { checked?: boolean | "mixed"; expanded: string | null; connected: boolean } {
  const el = this as HTMLInputElement;
  const ariaChecked = el.getAttribute("aria-checked");
  const native = el.tagName === "INPUT" && (el.type === "checkbox" || el.type === "radio");
  return {
    checked: native ? (el.indeterminate ? "mixed" : el.checked) : ariaChecked === "mixed" ? "mixed" : ariaChecked === "true" ? true : ariaChecked === "false" ? false : undefined,
    expanded: el.getAttribute("aria-expanded"),
    connected: el.isConnected,
  };
}

/** The visible label to click for a hidden checkbox/radio (returned as an object). */
export function fnVisibleLabel(this: Element): Element | null {
  const input = this as HTMLInputElement;
  const labels = (input.labels ? Array.from(input.labels) : []) as Element[];
  const parent = this.closest("label");
  if (parent && !labels.includes(parent)) labels.push(parent);
  for (const l of labels) {
    const rects = l.getClientRects();
    for (let i = 0; i < rects.length; i++) if (rects[i].width > 0 && rects[i].height > 0) return l;
  }
  return null;
}

/** Focus and select all existing content (fill replaces, Playwright semantics). */
export function fnFocusSelectAll(this: Element, selectAll: boolean): boolean {
  const el = this as HTMLElement;
  el.focus({ preventScroll: true });
  if (!selectAll) return document.activeElement === el || el.contains(document.activeElement);
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const input = el as HTMLInputElement;
    try { input.select(); } catch { /* number/email inputs may throw on setSelectionRange */ }
  } else if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  const active = document.activeElement;
  return active === el || el.contains(active) || (!!(el as any).shadowRoot && (el as any).shadowRoot.activeElement != null);
}

/** Current editable value (input/textarea value or contenteditable text). */
export function fnReadValue(this: Element): string {
  const el = this as HTMLElement;
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return String((el as HTMLInputElement).value ?? "");
  return el.isContentEditable ? (el.innerText ?? el.textContent ?? "") : (el.textContent ?? "");
}

/**
 * Set a value through the native setter and fire input + change (date, time,
 * color, range, month, week, datetime-local; also the verify fallback for text).
 */
export function fnSetValue(this: Element, value: string): string {
  const el = this as HTMLInputElement;
  if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    return el.textContent ?? "";
  }
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus({ preventScroll: true });
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return String(el.value);
}

/** Select options by value or visible label. Returns the selected values, or an error string. */
export function fnSelectOptions(this: Element, wanted: string[]): { selected: string[] } | { error: string; options: string[] } {
  const select = this as HTMLSelectElement;
  if (select.tagName !== "SELECT") return { error: "not a <select>", options: [] };
  const options = Array.from(select.options);
  const picked: HTMLOptionElement[] = [];
  for (const w of wanted) {
    const norm = w.trim().toLowerCase();
    const match = options.find((o) => o.value === w)
      ?? options.find((o) => o.label === w || o.text.trim() === w.trim())
      ?? options.find((o) => o.label.trim().toLowerCase() === norm || o.text.trim().toLowerCase() === norm);
    if (!match) return { error: `no option matching "${w}"`, options: options.slice(0, 50).map((o) => o.label || o.value) };
    if (match.disabled) return { error: `option "${w}" is disabled`, options: options.slice(0, 50).map((o) => o.label || o.value) };
    picked.push(match);
  }
  if (!select.multiple && picked.length > 1) return { error: "multiple values for a single <select>", options: [] };
  for (const o of options) o.selected = picked.includes(o);
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: picked.map((o) => o.value) };
}

/** Scroll the element's nearest scrollable ancestor (or the page) by a fraction of its viewport. */
export function fnScroll(this: Element | Window, direction: string, amount: number): { scrolled: boolean; target: string } {
  const isScrollable = (n: Element): boolean => {
    const s = getComputedStyle(n);
    const oy = /(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 1;
    const ox = /(auto|scroll|overlay)/.test(s.overflowX) && n.scrollWidth > n.clientWidth + 1;
    return oy || ox;
  };
  let target: Element | null = null;
  if (this && (this as Element).nodeType === 1) {
    for (let n: Element | null = this as Element; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
      if (isScrollable(n)) { target = n; break; }
    }
  }
  const scroller: Element = target ?? document.scrollingElement ?? document.documentElement;
  const vw = target ? target.clientWidth : innerWidth;
  const vh = target ? target.clientHeight : innerHeight;
  const dx = direction === "left" ? -vw * amount : direction === "right" ? vw * amount : 0;
  const dy = direction === "up" ? -vh * amount : direction === "down" ? vh * amount : 0;
  const beforeX = scroller.scrollLeft, beforeY = scroller.scrollTop;
  scroller.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
  return { scrolled: scroller.scrollLeft !== beforeX || scroller.scrollTop !== beforeY, target: target ? target.tagName.toLowerCase() : "page" };
}

/** Visibility of this frame's document (raw coordinate actions synthesize DOM events when hidden/unfocused). */
export function fnPageFocusState(): { visible: boolean; focused: boolean; dpr: number } {
  return { visible: document.visibilityState === "visible", focused: document.hasFocus(), dpr: devicePixelRatio || 1 };
}

/**
 * Synthesize a pointer/mouse sequence at a frame-local point on whatever is
 * there (hidden or unfocused tab, where CDP input may not be delivered).
 */
export function fnSynthPointer(kind: string, x: number, y: number, button: number, modifiers: number, deltaX: number, deltaY: number): { tag: string } {
  let root: Document | ShadowRoot = document;
  let el: Element | null = null;
  for (let i = 0; i < 32; i++) {
    const next: Element | null = root.elementFromPoint(x, y);
    if (!next || next === el) break;
    el = next;
    if (next.shadowRoot) root = next.shadowRoot; else break;
  }
  const target: Element = el ?? document.body ?? document.documentElement;
  const init = {
    bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y,
    button, buttons: kind === "up" ? 0 : 1 << (button === 1 ? 2 : button === 2 ? 1 : 0),
    altKey: (modifiers & 1) !== 0, ctrlKey: (modifiers & 2) !== 0, metaKey: (modifiers & 4) !== 0, shiftKey: (modifiers & 8) !== 0,
  };
  const fire = (type: string, detail = 1) => {
    const ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    target.dispatchEvent(new ctor(type, { ...init, detail, pointerId: 1, pointerType: "mouse", isPrimary: true } as PointerEventInit));
  };
  if (kind === "wheel") {
    target.dispatchEvent(new WheelEvent("wheel", { ...init, deltaX, deltaY, deltaMode: 0 }));
    (target.closest("*") ?? document.scrollingElement)?.scrollBy?.(deltaX, deltaY);
  } else if (kind === "hover") {
    fire("pointerover"); fire("pointerenter"); fire("mouseover"); fire("mouseenter"); fire("pointermove"); fire("mousemove");
  } else {
    const clicks = kind === "dblclick" ? 2 : 1;
    fire("pointermove"); fire("mousemove");
    for (let c = 1; c <= clicks; c++) {
      fire("pointerdown", c); fire("mousedown", c);
      if (c === 1 && target instanceof HTMLElement) target.focus({ preventScroll: true });
      fire("pointerup", c); fire("mouseup", c);
      if (button === 0) fire("click", c); else if (button === 2) fire("contextmenu", c); else fire("auxclick", c);
    }
    if (clicks === 2) fire("dblclick", 2);
  }
  return { tag: target.tagName.toLowerCase() };
}

/** HTML5 drag-and-drop with one shared DataTransfer (source = this, target = argument). */
export function fnDragDrop(this: Element, target: Element): { ok: boolean; dropped: boolean } {
  const dt = new DataTransfer();
  const center = (e: Element) => { const r = e.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }; };
  const s = center(this), t = center(target);
  const fire = (el: Element, type: string, at: { clientX: number; clientY: number }) =>
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at }));
  fire(this, "dragstart", s);
  fire(target, "dragenter", t);
  fire(target, "dragover", t);
  const dropped = !fire(target, "drop", t); // drop handlers call preventDefault()
  fire(this, "dragend", t);
  return { ok: true, dropped };
}

/** Upload fallback, part 1: stash one base64 chunk on the element (isolated-world expando). */
export function fnUploadChunk(this: Element, key: string, fileIndex: number, chunkIndex: number, b64: string): number {
  const store = ((this as any)[key] ??= { files: [] as Uint8Array[][] }) as { files: Uint8Array[][] };
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  (store.files[fileIndex] ??= [])[chunkIndex] = bytes;
  return bytes.length;
}

/**
 * Upload fallback, part 2: build File objects -> DataTransfer -> input.files
 * (+ input/change), or drop them on a drop zone (dragenter/dragover/drop).
 */
export function fnUploadCommit(this: Element, key: string, meta: { name: string; type: string; lastModified: number }[]): { count: number; names: string[]; mode: string } {
  const store = (this as any)[key] as { files: Uint8Array[][] } | undefined;
  const dt = new DataTransfer();
  meta.forEach((m, i) => {
    const parts = (store?.files[i] ?? []) as BlobPart[];
    dt.items.add(new File(parts, m.name, { type: m.type, lastModified: m.lastModified }));
  });
  delete (this as any)[key];
  const input = this as HTMLInputElement;
  if (input.tagName === "INPUT" && input.type === "file") {
    input.files = dt.files;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { count: input.files?.length ?? 0, names: Array.from(input.files ?? []).map((f) => f.name), mode: "input" };
  }
  const r = this.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ["dragenter", "dragover", "drop"]) {
    this.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at }));
  }
  return { count: dt.files.length, names: Array.from(dt.files).map((f) => f.name), mode: "drop" };
}

/** Number of files currently on a file input (upload verify). */
export function fnFileCount(this: Element): number {
  const input = this as HTMLInputElement;
  return input.files ? input.files.length : -1;
}

/**
 * Settle probe, installed per document in the utility world. Tracks DOM
 * mutations with a MutationObserver; returns readiness signals and the
 * fraction of nodes mutated since the previous probe with the same token.
 */
export function fnSettleProbe(token: string): {
  readyState: string; interactiveCount: number; textLen: number; landmarks: number; mutationRatio: number; mutations: number; nodes: number; url: string;
} {
  const g = globalThis as any;
  const KEY = "__obuSettleTracker";
  let t = g[KEY] as { doc: Document; count: number; seen: Record<string, number> } | undefined;
  if (!t || t.doc !== document) {
    t = { doc: document, count: 0, seen: {} };
    const tracker = t;
    try {
      new MutationObserver((records) => { tracker.count += records.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch { /* document not ready */ }
    g[KEY] = t;
  }
  const nodes = document.getElementsByTagName("*").length;
  const prev = t.seen[token];
  const mutated = prev === undefined ? 0 : t.count - prev;
  t.seen[token] = t.count;
  let interactive = 0;
  const candidates = document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[onclick],[tabindex]:not([tabindex='-1']),[contenteditable='true']");
  for (let i = 0; i < candidates.length && interactive < 5; i++) {
    const r = candidates[i].getClientRects();
    if (r.length && r[0].width > 0 && r[0].height > 0) interactive++;
  }
  const landmarks = document.querySelectorAll("main,nav,header,footer,aside,form,[role=main],[role=navigation],[role=banner],[role=search],[role=dialog],h1,h2").length;
  const text = (document.body?.innerText ?? "").length;
  return { readyState: document.readyState, interactiveCount: interactive, textLen: Math.min(text, 100000), landmarks, mutationRatio: mutated / Math.max(nodes, 1), mutations: mutated, nodes, url: location.href };
}

/** Query a CSS selector (or text=…) in the frame; returns the element or null. */
export function fnQuery(selector: string): Element | null {
  if (selector.startsWith("text=")) {
    const want = selector.slice(5).trim().toLowerCase();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
    let best: Element | null = null;
    for (let n = walker.nextNode() as Element | null; n; n = walker.nextNode() as Element | null) {
      const own = Array.from(n.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent ?? "").join("").trim().toLowerCase();
      if (own && own.includes(want)) { best = n; break; }
    }
    return best;
  }
  return document.querySelector(selector);
}

/** Page text contains (wait for:'text'). */
export function fnHasText(text: string): boolean {
  return (document.body?.innerText ?? "").includes(text);
}
