/**
 * The injected page runtime (`globalThis.__obu`), evaluated in the isolated
 * utility world of every frame.
 *
 * IMPORTANT: `installObu` is serialized with `Function.prototype.toString()`
 * (see ./index.ts), so it must be fully self-contained: no imports, no
 * references to module-level values, no helpers outside its body. Types are
 * fine (erased at compile time).
 *
 * Clean-room implementation. The role/accessible-name rules follow the WAI-ARIA
 * 1.2, HTML-AAM and accname 1.2 specs; the output format follows Playwright's
 * aria snapshot YAML (Apache-2.0, https://github.com/microsoft/playwright) —
 * no Playwright or Aside source is copied here.
 */
import type {
  InjectedSnapshot,
  ObuInjectedApi,
  ReadyFailure,
  Rect,
  SettleProbe,
  TakeSnapshotOptions,
} from "./api.js";

export function installObu(): void {
  const VERSION = "1.0.0";
  const g = globalThis as any;
  if (g.__obu && g.__obu.version === VERSION) return;

  // ---------------------------------------------------------------------------
  // Per-frame state
  // ---------------------------------------------------------------------------

  interface RefInfo {
    ref: string;
    role: string;
    name: string;
  }
  interface Fingerprint {
    role: string;
    name: string;
    nth: number;
  }

  const refOfElement = new WeakMap<Element, RefInfo>();
  const elementOfRef = new Map<string, WeakRef<Element>>();
  const fingerprintOfRef = new Map<string, Fingerprint>();
  let refCounter = 0;
  let currentOrdinal = 0;
  /** Folded-run refs: ref → {container, start}. snapshot({ref}) expands the container from `start` on. */
  const runOfRef = new Map<string, { container: WeakRef<Element>; start: WeakRef<Element> }>();
  const runRefOfStart = new WeakMap<Element, string>();
  /** Closed shadow roots handed to us by the daemon (DOM.getDocument{pierce} + DOM.resolveNode). */
  const closedRoots = new WeakMap<Element, ShadowRoot>();
  function shadowOf(el: Element | null | undefined): ShadowRoot | null {
    if (!el) return null;
    return el.shadowRoot || closedRoots.get(el) || null;
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "BASE"]);

  // ---------------------------------------------------------------------------
  // Per-snapshot caches
  // ---------------------------------------------------------------------------

  let styleCache = new Map<Element, CSSStyleDeclaration>();
  let hiddenCache = new Map<Element, boolean>();
  // Element boxes read during the walk, reused by budget fitting (no DOM writes in between).
  let rectCache = new Map<Element, DOMRect>();
  function cachedRect(el: Element): DOMRect {
    let r = rectCache.get(el);
    if (!r) {
      r = el.getBoundingClientRect();
      rectCache.set(el, r);
    }
    return r;
  }
  // href → short form; links repeat across snapshots of the same document.
  const urlCache = new Map<string, string>();
  let nameCache = new Map<Element, string>();
  let roleCache = new Map<Element, string>();

  function resetCaches(): void {
    styleCache = new Map();
    hiddenCache = new Map();
    nameCache = new Map();
    roleCache = new Map();
    textVisCache = new Map();
    rectCache = new Map();
  }

  function style(el: Element): CSSStyleDeclaration {
    let s = styleCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (shadow-aware)
  // ---------------------------------------------------------------------------

  function parentElementComposed(el: Element): Element | null {
    if (el.assignedSlot) return el.assignedSlot;
    const p = el.parentNode;
    if (!p) return null;
    if (p.nodeType === 11 /* DocumentFragment */) return (p as ShadowRoot).host ?? null;
    return p.nodeType === 1 ? (p as Element) : null;
  }

  function containsComposed(ancestor: Element, node: Element | null): boolean {
    let cur: Element | null = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = parentElementComposed(cur);
    }
    return false;
  }

  function deepElementFromPoint(x: number, y: number): Element | null {
    let el = document.elementFromPoint(x, y);
    while (el && shadowOf(el)) {
      const inner = shadowOf(el)!.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function getById(root: Node, id: string): Element | null {
    const r = (root as any).getRootNode ? (root as any).getRootNode() : document;
    return (r.getElementById ? r.getElementById(id) : null) ?? document.getElementById(id);
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  /** Subtree-hiding: display:none (incl. closed <details> content / hidden attr) or aria-hidden=true. */
  function isSubtreeHidden(el: Element): boolean {
    if (el.getAttribute("aria-hidden") === "true") return true;
    const s = style(el);
    if (s.display === "none") return true;
    // content-visibility:hidden (closed <details>, hidden=until-found) hides descendants.
    if (s.contentVisibility === "hidden") return true;
    // A fully transparent container hides its subtree; transparent native controls
    // themselves are kept (they are often styled custom checkboxes/radios).
    if (s.opacity === "0" && el.tagName !== "INPUT" && el.tagName !== "SELECT" && el.tagName !== "TEXTAREA") return true;
    return false;
  }

  let textVisCache = new Map<Element, boolean>();
  /** Text renders iff its parent is visible (visibility + content-visibility ancestors). Cached per snapshot. */
  function textParentVisible(el: Element): boolean {
    let v = textVisCache.get(el);
    if (v === undefined) {
      v = typeof (el as any).checkVisibility === "function" ? (el as any).checkVisibility({ visibilityProperty: true }) : style(el).visibility === "visible";
      // checkVisibility() is false for display:contents elements; their text still renders.
      if (!v && style(el).display === "contents") v = style(el).visibility === "visible";
      textVisCache.set(el, v!);
    }
    return v!;
  }

  /** Whether this element itself renders (box + visibility). Cached per snapshot. */
  function isVisible(el: Element): boolean {
    let v = hiddenCache.get(el);
    if (v !== undefined) return !v;
    const s = style(el);
    let hidden = false;
    if (s.visibility !== "visible") hidden = true;
    else if (s.display === "contents") hidden = false;
    else {
      const r = cachedRect(el);
      if (r.width === 0 && r.height === 0) {
        // Zero-size boxes can still show overflow children; treat as visible
        // only if a child has a box.
        hidden = !Array.from(el.children).some((c) => {
          const cr = cachedRect(c);
          return cr.width > 0 || cr.height > 0;
        });
      }
      if (!hidden && typeof (el as any).checkVisibility === "function" && !(el as any).checkVisibility()) {
        // Inside a content-visibility:hidden ancestor (e.g. a closed <details> slot in the UA shadow tree).
        hidden = true;
      }
    }
    hiddenCache.set(el, hidden);
    return !hidden;
  }

  // ---------------------------------------------------------------------------
  // Roles (HTML-AAM implicit roles)
  // ---------------------------------------------------------------------------

  const LANDMARKS = new Set(["banner", "complementary", "contentinfo", "form", "main", "navigation", "region", "search"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell", "listbox",
    "scrollbar",
  ]);
  const NAME_FROM_CONTENT = new Set([
    "button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab", "tooltip", "treeitem", "legend",
    "caption", "term", "code", "strong", "emphasis",
  ]);

  function hasAccessibleNameAttr(el: Element): boolean {
    return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") || el.hasAttribute("title");
  }

  function inputRole(el: HTMLInputElement): string {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    switch (type) {
      case "button": case "submit": case "reset": case "image": return "button";
      case "checkbox": return "checkbox";
      case "radio": return "radio";
      case "range": return "slider";
      case "number": return "spinbutton";
      case "search": return el.hasAttribute("list") ? "combobox" : "searchbox";
      case "hidden": return "";
      case "file": return "button";
      case "color": case "date": case "datetime-local": case "month": case "time": case "week": return "textbox";
      default: return el.hasAttribute("list") ? "combobox" : "textbox";
    }
  }

  const layoutTableCache = new WeakMap<Element, boolean>();
  /** Chrome-style heuristic: tables without data-table markers are layout tables (rendered as generic). */
  function isLayoutTable(table: Element | null): boolean {
    if (!table) return false;
    let v = layoutTableCache.get(table);
    if (v === undefined) {
      const explicit = table.getAttribute("role");
      v = !(explicit && explicit !== "presentation" && explicit !== "none") &&
        !table.querySelector(":scope > caption, :scope > thead, :scope > tfoot, :scope > colgroup, :scope > tbody > tr > th, :scope > tr > th, :scope > thead > tr > th") &&
        !table.hasAttribute("summary") && !table.hasAttribute("aria-label") && !table.hasAttribute("aria-labelledby");
      layoutTableCache.set(table, v);
    }
    return v;
  }

  function implicitRole(el: Element): string {
    const tag = el.tagName;
    if ((tag === "TABLE" || tag === "TR" || tag === "TD" || tag === "TH" || tag === "TBODY" || tag === "THEAD" || tag === "TFOOT") && isLayoutTable(tag === "TABLE" ? el : el.closest("table"))) return "generic";
    switch (tag) {
      case "A": case "AREA": return el.hasAttribute("href") ? "link" : "generic";
      case "ARTICLE": return "article";
      case "ASIDE": return "complementary";
      case "BUTTON": return "button";
      case "DATALIST": return "listbox";
      case "DD": return "definition";
      case "DETAILS": return "group";
      case "DIALOG": return "dialog";
      case "DT": return "term";
      case "FIELDSET": return "group";
      case "FIGURE": return "figure";
      case "FOOTER": return el.closest("article,aside,main,nav,section") ? "generic" : "contentinfo";
      case "FORM": return hasAccessibleNameAttr(el) ? "form" : "generic";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "HEADER": return el.closest("article,aside,main,nav,section") ? "generic" : "banner";
      case "HR": return "separator";
      case "IFRAME": return "iframe";
      case "IMG": {
        const alt = el.getAttribute("alt");
        if (alt === "" && !hasAccessibleNameAttr(el)) return "presentation";
        return "img";
      }
      case "SVG": case "svg": return el.getAttribute("aria-label") || el.querySelector?.(":scope > title") ? "img" : "presentation";
      case "INPUT": return inputRole(el as HTMLInputElement);
      case "LI": return "listitem";
      case "MAIN": return "main";
      case "MENU": case "OL": case "UL": return "list";
      case "METER": return "meter";
      case "NAV": return "navigation";
      case "OPTGROUP": return "group";
      case "OPTION": return "option";
      case "OUTPUT": return "status";
      case "P": return "paragraph";
      case "PROGRESS": return "progressbar";
      case "SEARCH": return "search";
      case "SECTION": return hasAccessibleNameAttr(el) ? "region" : "generic";
      case "SELECT": {
        const s = el as HTMLSelectElement;
        return s.multiple || s.size > 1 ? "listbox" : "combobox";
      }
      case "SUMMARY": return "button";
      case "TABLE": return "table";
      case "TBODY": case "THEAD": case "TFOOT": return "rowgroup";
      case "TD": return "cell";
      case "TEXTAREA": return "textbox";
      case "TH": {
        const scope = el.getAttribute("scope");
        if (scope === "row" || scope === "rowgroup") return "rowheader";
        return "columnheader";
      }
      case "TR": return "row";
      case "BLOCKQUOTE": return "blockquote";
      case "CAPTION": return "caption";
      case "CODE": return "code";
      case "STRONG": case "B": return "strong";
      case "EM": case "I": return "emphasis";
      case "LEGEND": return "legend";
      case "LABEL": return "label";
      default: return "generic";
    }
  }

  function getRole(el: Element): string {
    let r = roleCache.get(el);
    if (r !== undefined) return r;
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit && explicit !== "none" && explicit !== "presentation") r = explicit;
    else if (explicit === "none" || explicit === "presentation") r = isFocusable(el) ? implicitRole(el) : "presentation";
    else if ((el as HTMLElement).isContentEditable && !parentIsEditable(el)) r = "textbox";
    else r = implicitRole(el);
    roleCache.set(el, r);
    return r;
  }

  function parentIsEditable(el: Element): boolean {
    const p = parentElementComposed(el);
    return !!p && (p as HTMLElement).isContentEditable === true;
  }

  function isFocusable(el: Element): boolean {
    const ti = el.getAttribute("tabindex");
    if (ti !== null && ti !== "" && Number(ti) >= 0) return true;
    return el.matches("a[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[contenteditable=''],[contenteditable=true]");
  }

  // ---------------------------------------------------------------------------
  // Interactivity
  // ---------------------------------------------------------------------------

  function isNativeInteractive(el: Element): boolean {
    switch (el.tagName) {
      case "A": return el.hasAttribute("href");
      case "BUTTON": case "SELECT": case "TEXTAREA": case "SUMMARY": case "IFRAME": case "AREA": return true;
      case "INPUT": return (el as HTMLInputElement).type !== "hidden";
      case "LABEL": return false;
      default: return false;
    }
  }

  function hasOwnPointerCursor(el: Element): boolean {
    if (style(el).cursor !== "pointer") return false;
    const p = parentElementComposed(el);
    return !p || style(p).cursor !== "pointer";
  }

  function isInteractive(el: Element, role: string): boolean {
    if (isNativeInteractive(el)) return true;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && ti !== "" && Number(ti) >= 0) return true;
    if ((el as HTMLElement).isContentEditable && !parentIsEditable(el)) return true;
    if (hasOwnPointerCursor(el)) return true;
    if (isDropTarget(el)) return true;
    return false;
  }

  // Drop zones take files via drag-and-drop listeners the isolated world cannot see; give
  // them a ref (act({action:'upload'}) dispatches a synthetic drop) when the markup says so:
  // drop handler attributes, a dropzone class/attribute, or a short "drop/drag … here" label.
  const DROP_TEXT = /\b(drop|drag)\b[^.]{0,40}\b(here|files?|zone|area|images?|photos?)\b|\bdrop ?zone\b/i;
  function isDropTarget(el: Element): boolean {
    if (el.hasAttribute("ondrop") || el.hasAttribute("ondragover") || el.hasAttribute("dropzone") || el.hasAttribute("data-dropzone")) return true;
    const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "";
    const label = el.getAttribute("aria-label") || "";
    if (!/dropzone|drop-zone|drop_zone/i.test(cls) && !DROP_TEXT.test(label)) {
      // textContent (no layout) keeps this cheap on every visited element.
      const t = el.textContent;
      if (!t || t.length > 120 || !DROP_TEXT.test(t)) return false;
      // Only the innermost box whose text says so (not every ancestor of the text).
      for (const c of Array.from(el.children)) if (DROP_TEXT.test(c.textContent || "")) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 20;
  }

  function isScrollable(el: Element): boolean {
    if (el === document.documentElement || el === document.body) return false;
    const s = style(el);
    const oy = s.overflowY;
    const ox = s.overflowX;
    const canY = (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4;
    const canX = (ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 4;
    return canY || canX;
  }

  // ---------------------------------------------------------------------------
  // Accessible name (accname 1.2, simplified)
  // ---------------------------------------------------------------------------

  function normalizeWs(s: string): string {
    return s.replace(/[\s ​]+/g, " ").trim();
  }

  function cut(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  /**
   * Text of a CSS `content` value: concatenated string tokens; when alt text is
   * given (`content: "[" / ""`), the alt text is what assistive tech reads.
   */
  function cssContentText(c: string): string {
    const strings: string[][] = [[]];
    let i = 0;
    while (i < c.length) {
      const ch = c[i];
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        let buf = "";
        while (j < c.length && c[j] !== ch) {
          if (c[j] === "\\" && j + 1 < c.length) {
            j++;
          }
          buf += c[j];
          j++;
        }
        strings[strings.length - 1].push(buf);
        i = j + 1;
      } else if (ch === "/") {
        strings.push([]);
        i++;
      } else i++;
    }
    const chosen = strings.length > 1 ? strings[strings.length - 1] : strings[0];
    return chosen.join("");
  }

  function pseudoText(el: Element, which: "::before" | "::after"): string {
    try {
      const c = getComputedStyle(el, which).content;
      if (!c || c === "none" || c === "normal") return "";
      return cssContentText(c);
    } catch {
      return "";
    }
  }

  function labelsText(el: Element, depth: number, visited: Set<Element>): string {
    const labels = (el as HTMLInputElement).labels;
    if (!labels || !labels.length) return "";
    const parts: string[] = [];
    for (const l of Array.from(labels)) parts.push(textAlternative(l, depth + 1, visited, true, el));
    return normalizeWs(parts.join(" "));
  }

  function textAlternative(el: Element, depth: number, visited: Set<Element>, fromContent: boolean, exclude?: Element): string {
    if (depth > 10 || visited.has(el)) return "";
    visited.add(el);
    if (fromContent && depth > 0 && isSubtreeHidden(el)) return "";

    // aria-labelledby (not followed recursively)
    if (depth === 0) {
      const lb = el.getAttribute("aria-labelledby");
      if (lb) {
        const t = lb
          .split(/\s+/)
          .map((id) => getById(el, id))
          .filter((x): x is Element => !!x)
          .map((x) => textAlternative(x, depth + 1, visited, true))
          .join(" ");
        if (normalizeWs(t)) return normalizeWs(t);
      }
    }
    const al = el.getAttribute("aria-label");
    if (al && al.trim()) return normalizeWs(al);

    const tag = el.tagName;
    // Embedded controls inside a label: use their value.
    if (depth > 0 && el !== exclude) {
      if (tag === "INPUT") {
        const t = (el as HTMLInputElement).type;
        if (t === "checkbox" || t === "radio") return "";
        if (t === "button" || t === "submit" || t === "reset") return (el as HTMLInputElement).value || "";
        return (el as HTMLInputElement).value || "";
      }
      if (tag === "TEXTAREA") return (el as HTMLTextAreaElement).value;
      if (tag === "SELECT") {
        const s = el as HTMLSelectElement;
        return Array.from(s.selectedOptions).map((o) => o.text).join(" ");
      }
    }
    if (el === exclude) return "";

    if (depth === 0) {
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "METER" || tag === "PROGRESS" || tag === "OUTPUT") {
        const t = (el as HTMLInputElement).type;
        if (tag === "INPUT" && (t === "button" || t === "submit" || t === "reset")) {
          const v = (el as HTMLInputElement).value;
          if (v) return normalizeWs(v);
          if (t === "submit") return "Submit";
          if (t === "reset") return "Reset";
        }
        if (tag === "INPUT" && t === "image") {
          const alt = el.getAttribute("alt");
          if (alt) return normalizeWs(alt);
        }
        const lt = labelsText(el, depth, visited);
        if (lt) return lt;
        if (tag === "INPUT" && (t === "button" || t === "submit" || t === "reset" || t === "image")) {
          return normalizeWs(el.getAttribute("title") || "");
        }
        const ph = el.getAttribute("placeholder") || el.getAttribute("aria-placeholder");
        const title = el.getAttribute("title");
        return normalizeWs(title || ph || "");
      }
      if (tag === "IMG" || tag === "AREA") {
        const alt = el.getAttribute("alt");
        if (alt && alt.trim()) return normalizeWs(alt);
      }
      if (tag === "FIELDSET") {
        const lg = el.querySelector(":scope > legend");
        if (lg) return textAlternative(lg, depth + 1, visited, true);
      }
      if (tag === "TABLE") {
        const cap = el.querySelector(":scope > caption");
        if (cap) return textAlternative(cap, depth + 1, visited, true);
      }
      if (tag === "FIGURE") {
        const fc = el.querySelector(":scope > figcaption");
        if (fc) return textAlternative(fc, depth + 1, visited, true);
      }
      if (tag === "svg" || tag === "SVG") {
        const t = el.querySelector(":scope > title");
        if (t && t.textContent) return normalizeWs(t.textContent);
      }
    }

    const role = getRole(el);
    if (fromContent || NAME_FROM_CONTENT.has(role) || depth > 0) {
      if (depth > 0 && tag === "IMG") return normalizeWs(el.getAttribute("alt") || "");
      const parts: string[] = [pseudoText(el, "::before")];
      const children: Node[] = [];
      if (shadowOf(el)) children.push(...Array.from(shadowOf(el)!.childNodes));
      else if (tag === "SLOT") children.push(...(el as HTMLSlotElement).assignedNodes({ flatten: true }));
      else children.push(...Array.from(el.childNodes));
      for (const c of children) {
        if (c.nodeType === 3) parts.push(c.textContent || "");
        else if (c.nodeType === 1) {
          const ce = c as Element;
          if (SKIP_TAGS.has(ce.tagName)) continue;
          const t = textAlternative(ce, depth + 1, visited, true, exclude);
          const disp = style(ce).display;
          const block = disp !== "inline" && disp !== "contents" && disp !== "inline-block" && disp !== "inline-flex";
          parts.push(block ? ` ${t} ` : t);
        }
      }
      parts.push(pseudoText(el, "::after"));
      const t = normalizeWs(parts.join(""));
      if (t) return t;
    }
    const title = el.getAttribute("title");
    return title ? normalizeWs(title) : "";
  }

  function accessibleName(el: Element, role: string): string {
    let n = nameCache.get(el);
    if (n !== undefined) return n;
    if (role === "generic" || role === "presentation" || role === "paragraph" || role === "listitem" || role === "list" || role === "row" || role === "table" && !el.querySelector(":scope > caption")) {
      // These roles prohibit naming (or we render their content as children instead).
      const al = el.getAttribute("aria-label");
      n = al ? cut(normalizeWs(al), 100) : "";
    } else {
      n = cut(textAlternative(el, 0, new Set(), NAME_FROM_CONTENT.has(role)), 100);
    }
    nameCache.set(el, n);
    return n;
  }

  // ---------------------------------------------------------------------------
  // States
  // ---------------------------------------------------------------------------

  function isDisabled(el: Element): boolean {
    if ((el as any).disabled === true) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    const fs = el.closest("fieldset[disabled]");
    if (fs && el.matches("input,select,textarea,button")) {
      const firstLegend = fs.querySelector(":scope > legend");
      if (!firstLegend || !firstLegend.contains(el)) return true;
    }
    return false;
  }

  function checkedState(el: Element, role: string): boolean | "mixed" | undefined {
    if (el.tagName === "INPUT") {
      const i = el as HTMLInputElement;
      if (i.type === "checkbox" || i.type === "radio") return i.indeterminate ? "mixed" : i.checked;
    }
    if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio" || role === "treeitem") {
      const a = el.getAttribute("aria-checked");
      if (a === "true") return true;
      if (a === "mixed") return "mixed";
      if (a === "false") return false;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Aria tree
  // ---------------------------------------------------------------------------

  interface AriaNode {
    role: string;
    name: string;
    ref?: string;
    props: string[];
    /** Inline value (textbox value, combobox selection, etc.). */
    value?: string;
    children: (AriaNode | string)[];
    interactive: boolean;
    keep: boolean;
    /** Name was computed from descendant content (dropped when the children render it). */
    nameFromContent?: boolean;
    el?: Element;
    /** Transparent grouping (an unwrapped DOM container kept as a unit for budget compaction). Renders its children in place. */
    group?: boolean;
    /** Set when budget compaction folded this subtree; rendered instead of the children. */
    collapsed?: string;
    /** Synthetic chunk of a long sibling run: geometry = span of its first..last child. */
    span?: boolean;
    /** Merged folded run: element its expansion starts from. */
    start?: Element;
  }

  function assignRef(el: Element, role: string, name: string): string {
    const prev = refOfElement.get(el);
    const prefix = currentOrdinal === 0 ? "e" : `f${currentOrdinal}e`;
    if (prev && prev.role === role && prev.name === name && prev.ref.startsWith(prefix) && elementOfRef.get(prev.ref)?.deref() === el) {
      return prev.ref;
    }
    let ref: string;
    do {
      ref = `${prefix}${++refCounter}`;
    } while (elementOfRef.has(ref) && elementOfRef.get(ref)?.deref()?.isConnected);
    refOfElement.set(el, { ref, role, name });
    elementOfRef.set(ref, new WeakRef(el));
    return ref;
  }

  interface WalkCtx {
    interactiveOnly: boolean;
    showHidden: boolean;
    maxDepth: number;
    iframes: InjectedSnapshot["iframes"];
    owned: Set<Element>;
    refNodes: { ref: string; role: string; name: string }[];
    focused: Element | null;
  }

  function deepActiveElement(): Element | null {
    let a: Element | null = document.activeElement;
    while (a && shadowOf(a) && shadowOf(a)!.activeElement) a = shadowOf(a)!.activeElement;
    return a;
  }

  function childNodesOf(el: Element | Document | ShadowRoot): Node[] {
    const sr = (el as Element).nodeType === 1 ? shadowOf(el as Element) : null;
    if (sr) return Array.from(sr.childNodes);
    if ((el as Element).tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(el.childNodes);
    }
    return Array.from(el.childNodes);
  }

  function shortUrl(href: string): string {
    const key = location.href + "\n" + href;
    let v = urlCache.get(key);
    if (v === undefined) {
      if (urlCache.size > 5000) urlCache.clear();
      v = shortUrlUncached(href);
      urlCache.set(key, v);
    }
    return v;
  }

  function shortUrlUncached(href: string): string {
    try {
      const u = new URL(href, location.href);
      if (u.protocol === "javascript:" || u.protocol === "data:" || u.protocol === "vbscript:") return "";
      if (u.origin === location.origin) return cut(u.pathname + u.search + u.hash, 120);
      return cut(u.href, 120);
    } catch {
      return "";
    }
  }

  function visit(node: Node, parent: AriaNode, depth: number, ctx: WalkCtx): void {
    if (depth > ctx.maxDepth) return;
    if (node.nodeType === 3) {
      if (ctx.interactiveOnly) return;
      const t = node.textContent || "";
      if (!t.trim()) {
        if (t.length && parent.children.length && typeof parent.children[parent.children.length - 1] === "string") parent.children.push(" ");
        return;
      }
      const pe = node.parentElement;
      if (pe && !ctx.showHidden && !textParentVisible(pe)) return;
      parent.children.push(t);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (ctx.owned.has(el)) return; // rendered under its aria-owns owner instead
    if (!ctx.showHidden && isSubtreeHidden(el)) return;

    const role = getRole(el);
    const visible = ctx.showHidden || isVisible(el);

    if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
      if (!visible) return;
      const name = accessibleName(el, "iframe");
      const ref = assignRef(el, "iframe", name);
      const src = (el as HTMLIFrameElement).src || "";
      let origin = "";
      try {
        origin = src ? new URL(src, location.href).origin : location.origin;
      } catch {
        origin = "";
      }
      ctx.iframes.push({ ref, frameName: el.getAttribute("name") || undefined, src });
      ctx.refNodes.push({ ref, role: "iframe", name });
      parent.children.push({ role: "iframe", name, ref, props: origin && origin !== "null" ? [`origin=${origin}`] : [], children: [], interactive: true, keep: true, el });
      return;
    }

    const interactive = visible && role !== "presentation" && isInteractive(el, role);
    const named = role !== "generic" && role !== "presentation";
    const scroll = visible && !ctx.interactiveOnly && isScrollable(el);

    let target: AriaNode = parent;
    let me: AriaNode | null = null;
    if (visible && (named || interactive || scroll)) {
      const effRole = role === "presentation" ? "generic" : role;
      const name = accessibleName(el, effRole);
      me = { role: effRole, name, props: [], children: [], interactive, keep: interactive || LANDMARKS.has(effRole) || effRole === "heading" || effRole === "dialog" || effRole === "alertdialog", el };
      if (name && NAME_FROM_CONTENT.has(effRole) && !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !(el.tagName === "INPUT" || el.tagName === "IMG")) me.nameFromContent = true;
      if (interactive) {
        me.ref = assignRef(el, effRole, name);
        ctx.refNodes.push({ ref: me.ref, role: effRole, name });
        // Interactive snapshots drop text runs, so an unnamed clickable generic (cursor:pointer /
        // onclick div) would render as a bare `generic [ref]`. Show its own text as the name —
        // display only: the ref fingerprint keeps the accessible name, so refs match full mode.
        if (!name && ctx.interactiveOnly && effRole === "generic") me.name = cut(normalizeWs((el as HTMLElement).innerText || el.textContent || ""), 80);
      }
      fillProps(el, me, ctx);
      target = me;
      parent.children.push(me);
    }

    // Children
    if (!ctx.interactiveOnly && visible) {
      const before = pseudoText(el, "::before");
      if (before) target.children.push(before);
    }
    if (el.tagName === "SELECT") {
      // Options of a native select: listed without refs (act({action:'select'}) picks by value/label).
      if (!ctx.interactiveOnly && me) {
        const opts = Array.from((el as HTMLSelectElement).options).slice(0, 50);
        for (const o of opts) {
          const on: AriaNode = { role: "option", name: cut(normalizeWs(o.text), 100), props: o.selected ? ["selected"] : [], children: [], interactive: false, keep: false };
          if (o.disabled) on.props.push("disabled");
          me.children.push(on);
        }
        const total = (el as HTMLSelectElement).options.length;
        if (total > 50) me.children.push(`… ${total - 50} more options`);
      }
    } else if (el.tagName !== "TEXTAREA" && !(el.tagName === "INPUT")) {
      for (const c of childNodesOf(el)) visit(c, target, depth + 1, ctx);
      const ownsAttr = el.getAttribute("aria-owns");
      if (ownsAttr) {
        for (const id of ownsAttr.split(/\s+/)) {
          const o = getById(el, id);
          if (o && !containsComposed(el, o)) visit(o, target, depth + 1, { ...ctx, owned: new Set() });
        }
      }
    }
    if (!ctx.interactiveOnly && visible) {
      const after = pseudoText(el, "::after");
      if (after) target.children.push(after);
    }
    if (!ctx.interactiveOnly && visible && !me) {
      // Block-level generic wrappers separate text runs.
      const d = style(el).display;
      if (d !== "inline" && d !== "contents" && parent.children.length && typeof parent.children[parent.children.length - 1] === "string") parent.children.push("\n");
    }
  }

  function fillProps(el: Element, n: AriaNode, ctx: WalkCtx): void {
    const role = n.role;
    if (role === "heading") {
      const lvl = el.getAttribute("aria-level") || (/^H([1-6])$/.exec(el.tagName) || [])[1];
      if (lvl) n.props.push(`level=${lvl}`);
    }
    const ch = checkedState(el, role);
    if (ch === true) n.props.push("checked");
    else if (ch === "mixed") n.props.push("checked=mixed");
    if (isDisabled(el)) n.props.push("disabled");
    const exp = el.getAttribute("aria-expanded");
    if (exp === "true") n.props.push("expanded");
    else if (exp === "false") n.props.push("expanded=false");
    else if (el.tagName === "SUMMARY" && el.parentElement?.tagName === "DETAILS") n.props.push((el.parentElement as HTMLDetailsElement).open ? "expanded" : "expanded=false");
    if (el.getAttribute("aria-selected") === "true" || (el.tagName === "OPTION" && (el as HTMLOptionElement).selected)) n.props.push("selected");
    const pressed = el.getAttribute("aria-pressed");
    if (pressed === "true") n.props.push("pressed");
    else if (pressed === "mixed") n.props.push("pressed=mixed");
    if (el.matches?.(":required") || el.getAttribute("aria-required") === "true") n.props.push("required");
    if (el.getAttribute("aria-invalid") === "true") n.props.push("invalid");
    if (ctx.focused === el) n.props.push("focused");
    if (role === "link") {
      const href = (el as HTMLAnchorElement).href;
      if (href) {
        const u = shortUrl(href);
        if (u) n.props.push(`url=${u}`);
      }
    }
    if (n.interactive && role === "generic" && hasOwnPointerCursor(el)) n.props.push("cursor=pointer");
    if (n.interactive && !isNativeInteractive(el) && isDropTarget(el)) n.props.push("droptarget");
    if (isScrollableCached(el)) n.props.push("scrollable");

    // Values
    if (el.tagName === "INPUT") {
      const i = el as HTMLInputElement;
      const t = i.type;
      if (t === "password") {
        if (i.value) n.value = "[redacted]";
      } else if (t === "file") {
        if (i.files && i.files.length) n.value = Array.from(i.files).map((f) => f.name).join(", ");
      } else if (t !== "checkbox" && t !== "radio" && t !== "button" && t !== "submit" && t !== "reset" && t !== "image") {
        if (i.value) n.value = cut(i.value, 200);
        if (role === "slider") {
          n.props.push(`min=${i.min || 0}`, `max=${i.max || 100}`);
        }
      }
      if (t === "file") n.props.push("file");
    } else if (el.tagName === "TEXTAREA") {
      const v = (el as HTMLTextAreaElement).value;
      if (v) n.value = cut(v, 400);
    } else if (el.tagName === "SELECT") {
      const s = el as HTMLSelectElement;
      const sel = Array.from(s.selectedOptions).map((o) => normalizeWs(o.text)).join(", ");
      if (sel) n.value = cut(sel, 200);
    } else if (role === "textbox" && (el as HTMLElement).isContentEditable) {
      // content renders as children
    } else if (role === "slider" || role === "spinbutton" || role === "progressbar" || role === "meter") {
      const v = el.getAttribute("aria-valuetext") || el.getAttribute("aria-valuenow") || (el as any).value;
      if (v !== null && v !== undefined && v !== "") n.value = String(v);
    }
    if (el.getAttribute("contenteditable") !== null && (el as HTMLElement).isContentEditable && role !== "textbox") n.props.push("editable");
  }

  function isScrollableCached(el: Element): boolean {
    try {
      return isScrollable(el);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Compaction
  // ---------------------------------------------------------------------------

  function normalizeChildren(n: AriaNode): void {
    // Merge adjacent strings; normalise whitespace.
    const out: (AriaNode | string)[] = [];
    let buf = "";
    const flush = () => {
      const t = normalizeWs(buf);
      if (t) out.push(t);
      buf = "";
    };
    for (const c of n.children) {
      if (typeof c === "string") buf += c;
      else {
        flush();
        out.push(c);
      }
    }
    flush();
    n.children = out;
  }

  /** Drop layout noise: separator-only text and label text duplicated by the adjacent control's name. */
  function cleanChildren(n: AriaNode): void {
    // Separator-only text runs ("|", "·", "(" …) are layout noise.
    n.children = n.children.filter((c) => typeof c !== "string" || !/^[|·•/,;:()[\]\-–—]+$/.test(c));
    // Label text right next to the control it names (e.g. `text: Email` +
    // `textbox "Email"`) → drop the text; the name already carries it.
    if (n.children.length > 1) {
      const kids2: (AriaNode | string)[] = [];
      for (let i = 0; i < n.children.length; i++) {
        const c = n.children[i];
        if (typeof c === "string") {
          const prev = n.children[i - 1];
          const next = n.children[i + 1];
          const t = normalizeWs(c);
          if ((next && typeof next !== "string" && next.ref && next.name === t) || (prev && typeof prev !== "string" && prev.ref && prev.name === t)) continue;
        } else if (!c.ref && !c.children.length && (c.role === "caption" || c.role === "legend") && c.name === n.name) {
          continue;
        }
        kids2.push(c);
      }
      n.children = kids2;
    }
  }

  /**
   * Unwrap `n` but, in budget mode, keep its children together as a
   * transparent group so the budget pass can fold them as one unit.
   */
  function unwrap(n: AriaNode, grouping: boolean): (AriaNode | string)[] {
    const kids = n.children;
    if (!grouping || !n.el || kids.length < 2) return kids;
    let nodes = 0;
    for (const c of kids) if (typeof c !== "string") nodes++;
    if (nodes < 2) return kids;
    return [{ role: "group", name: "", props: [], children: kids, interactive: false, keep: false, el: n.el, group: true }];
  }

  /** Returns replacement nodes for `n` (unwrapping, dropping). */
  function compact(n: AriaNode, interactiveOnly: boolean, grouping = false): (AriaNode | string)[] {
    const kids: (AriaNode | string)[] = [];
    for (const c of n.children) {
      if (typeof c === "string") kids.push(c);
      else kids.push(...compact(c, interactiveOnly, grouping));
    }
    n.children = kids;
    normalizeChildren(n);

    if (interactiveOnly) {
      // Keep only refs, landmarks, headings and dialogs (+ their ancestors).
      const hasKeptDesc = n.children.some((c) => typeof c !== "string");
      if (!n.keep) return unwrap(n, grouping);
      if (!hasKeptDesc && !n.ref && n.role !== "heading" && !n.name) return [];
      return [n];
    }

    // Name computed from content while children render that content → keep the children only.
    if (n.nameFromContent && n.children.some((c) => typeof c !== "string")) n.name = "";
    cleanChildren(n);
    // Name equal to sole text content → drop the duplicate text.
    if (n.children.length === 1 && typeof n.children[0] === "string" && n.name && normalizeWs(n.children[0] as string) === n.name) {
      n.children = [];
    }
    // Text that repeats the name prefix (name-from-content of nested inline nodes).
    if (n.name && n.children.length && n.children.every((c) => typeof c === "string") && normalizeWs((n.children as string[]).join(" ")) === n.name) {
      n.children = [];
    }

    if (n.role === "generic" && !n.ref && !n.name && !n.props.length) {
      // Unwrap empty generic wrappers.
      return unwrap(n, grouping);
    }
    if (n.role === "generic" && !n.ref && !n.name && n.props.length === 1 && n.props[0] === "scrollable" && !n.children.length) {
      return [];
    }
    if ((n.role === "list" || n.role === "group" || n.role === "rowgroup" || n.role === "figure" || n.role === "label" || n.role === "strong" || n.role === "emphasis" || n.role === "code" || n.role === "status") && !n.ref && !n.name && !n.props.length) {
      if (!n.children.length) return [];
      if (n.role === "rowgroup" || n.role === "label" || n.role === "strong" || n.role === "emphasis" || n.role === "status") return unwrap(n, grouping);
      if (n.role === "code" && n.children.every((c) => typeof c === "string")) return n.children;
    }
    if (!n.ref && !n.name && !n.children.length && !n.props.length && n.role !== "separator" && n.role !== "img") return [];
    return [n];
  }

  // ---------------------------------------------------------------------------
  // Budget compaction: fold far-away / bulky subtrees into one-line summaries
  // with a ref the agent can snapshot({ref}) to expand. Never drops refs that
  // are on screen while far-away content can still be folded.
  // ---------------------------------------------------------------------------

  interface BudgetCtx {
    /** Viewport band [top, bottom] in client coordinates (scoped snapshots: the scope root's top). */
    bandTop: number;
    bandBottom: number;
    focused: Element | null;
    refNodes: { ref: string; role: string; name: string }[];
    collapsed: number;
    /** Expanding a folded run: everything above its first item folds before anything below. */
    aboveFirst?: boolean;
  }

  const CITATION = /^(\[(\d+|[a-z]{1,2}|note \d+|citation needed|nb \d+)\]|\^|↑)$/i;

  function renderedLength(nodes: (AriaNode | string)[]): number {
    const out: string[] = [];
    render(nodes, "", out);
    let n = 0;
    for (const l of out) n += l.length + 1;
    return n;
  }

  /** Cheap rewrites that lose nothing an agent acts on. */
  function tidyForBudget(nodes: (AriaNode | string)[], interactiveOnly: boolean): (AriaNode | string)[] {
    const out: (AriaNode | string)[] = [];
    let prevUrl = "";
    for (const c of nodes) {
      if (typeof c === "string") {
        out.push(!interactiveOnly && c.length > 400 ? cut(c, 280) + ` (+${c.length - 280} chars)` : c);
        prevUrl = "";
        continue;
      }
      if (c.role === "link" && CITATION.test(c.name)) continue; // footnote markers
      const urlIdx = c.props.findIndex((p) => p.startsWith("url="));
      if (urlIdx >= 0) {
        const full = c.props[urlIdx].slice(4);
        let u = full;
        if (u.startsWith("#") || (u.includes("#") && u.split("#")[0] === location.pathname)) {
          c.props.splice(urlIdx, 1);
          u = "";
        } else {
          const q = u.indexOf("?");
          if (q >= 0 && u.length - q > 32) u = u.slice(0, q) + "?…";
          if (u.length > 90) u = u.slice(0, 89) + "…";
          c.props[urlIdx] = `url=${u}`;
        }
        // Image link + title link to the same place (same full href): keep the named one.
        if (u && full === prevUrl && c.role === "link" && !c.children.length) {
          const last = out[out.length - 1];
          if (last && typeof last !== "string" && last.role === "link") {
            if (!last.name && c.name) out[out.length - 1] = c;
            continue;
          }
        }
        prevUrl = u ? full : "";
      } else prevUrl = "";
      c.children = tidyForBudget(c.children, interactiveOnly);
      out.push(c);
    }
    return out;
  }

  interface Cand {
    node: AriaNode;
    parent: Cand | null;
    cost: number;
    dist: number;
    depth: number;
    /** Top edge relative to the band top (on-screen ordering: lower parts fold first). */
    y: number;
  }

  function lineCost(n: AriaNode, depth: number): number {
    return depth * 2 + 3 + header(n).length + (n.value ? n.value.length + 4 : 0);
  }

  function nodeRect(n: AriaNode): DOMRect | null {
    if (!n.el) return null;
    const r = n.span ? new DOMRect(0, 0, 0, 0) : cachedRect(n.el);
    if (r.width || r.height) return r;
    // display:contents wrappers → union of first/last element children with boxes.
    const kids = n.children.filter((c): c is AriaNode => typeof c !== "string" && !!c.el);
    if (!kids.length) return null;
    const a = cachedRect(kids[0].el!);
    const b = cachedRect(kids[kids.length - 1].el!);
    return new DOMRect(Math.min(a.left, b.left), Math.min(a.top, b.top), Math.max(a.right, b.right) - Math.min(a.left, b.left), Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top));
  }

  function summarize(n: AriaNode): string {
    const counts = new Map<string, number>();
    const names: string[] = [];
    let heading = "";
    const walk = (c: AriaNode | string) => {
      if (typeof c === "string") return;
      if (c.role === "heading" && !heading) heading = c.name;
      if (c.ref && c !== n) {
        counts.set(c.role, (counts.get(c.role) ?? 0) + 1);
        if (c.name && names.length < 3 && !names.includes(c.name)) names.push(cut(c.name, 32));
      }
      if (c.collapsed && c !== n) {
        const m = /^(\d+) refs?/.exec(c.collapsed);
        if (m) counts.set("item", (counts.get("item") ?? 0) + Number(m[1]));
      }
      for (const k of c.children) walk(k);
    };
    for (const k of n.children) walk(k);
    let total = 0;
    for (const v of counts.values()) total += v;
    const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, k]) => `${k} ${r}${k > 1 ? "s" : ""}`);
    let s = total ? `${total} ref${total > 1 ? "s" : ""} (${parts.join(", ")})` : "text only";
    if (heading && heading !== n.name) s += ` · ${cut(heading, 48)}`;
    else if (names.length) s += ` · ${names.join(" | ")}`;
    return s;
  }

  function containsFocus(n: AriaNode, focused: Element | null): boolean {
    return !!(focused && n.el && (n.el === focused || containsComposed(n.el, focused)));
  }

  function collapseNode(n: AriaNode, bctx: BudgetCtx): void {
    if (n.span) n.start = firstElementOf(n) ?? undefined; // children are about to go
    n.collapsed = summarize(n);
    n.children = [];
    if (!n.ref && n.el) {
      const role = n.group ? "group" : n.role;
      n.ref = assignRef(n.el, role, n.group ? "" : n.name);
      if (!bctx.refNodes.some((r) => r.ref === n.ref)) bctx.refNodes.push({ ref: n.ref, role, name: n.group ? "" : n.name });
    }
    n.value = undefined;
    bctx.collapsed++;
  }

  function lowestCommonAncestor(els: Element[]): Element | null {
    if (!els.length) return null;
    const chain: Element[] = [];
    for (let e: Element | null = els[0]; e; e = parentElementComposed(e)) chain.push(e);
    let best = 0;
    for (const el of els.slice(1)) {
      while (best < chain.length && !containsComposed(chain[best], el)) best++;
    }
    return chain[best] ?? null;
  }

  function firstElementOf(n: AriaNode): Element | null {
    if (n.start) return n.start;
    if (!n.span) return n.el ?? null;
    for (const k of n.children) if (typeof k !== "string" && k.el) return firstElementOf(k);
    return n.el ?? null;
  }

  /** Stable ref for "container, from `start` on" (does not disturb element refs). */
  function runRef(container: Element, start: Element, bctx: BudgetCtx): string {
    const prev = runRefOfStart.get(start);
    const prefix = currentOrdinal === 0 ? "e" : `f${currentOrdinal}e`;
    let ref = prev && runOfRef.get(prev)?.container.deref() === container && prev.startsWith(prefix) ? prev : "";
    if (!ref) {
      do {
        ref = `${prefix}${++refCounter}`;
      } while (elementOfRef.has(ref) && elementOfRef.get(ref)?.deref()?.isConnected);
      runRefOfStart.set(start, ref);
      runOfRef.set(ref, { container: new WeakRef(container), start: new WeakRef(start) });
    }
    elementOfRef.set(ref, new WeakRef(container));
    if (!bctx.refNodes.some((r) => r.ref === ref)) bctx.refNodes.push({ ref, role: "group", name: "" });
    return ref;
  }

  function refCountOf(collapsed: string | undefined): number {
    const m = /(\d+) refs?/.exec(collapsed || "");
    return m ? Number(m[1]) : 0;
  }

  /** Merge runs of ≥2 folded siblings into one line keyed by their common container. */
  function mergeCollapsedRuns(nodes: (AriaNode | string)[], bctx: BudgetCtx): (AriaNode | string)[] {
    // Recurse first, then inline transparent groups that ended up fully folded so
    // runs spanning chunk boundaries merge into one line.
    const flat: (AriaNode | string)[] = [];
    for (const c of nodes) {
      if (typeof c === "string" || c.collapsed) {
        flat.push(c);
        continue;
      }
      c.children = mergeCollapsedRuns(c.children, bctx);
      if (!c.group) {
        flat.push(c);
        continue;
      }
      // Transparent group: hoist folded children at its edges so they can join
      // folded neighbours outside it (rendering is unchanged — groups are invisible).
      const kids = c.children;
      const isFolded = (k: AriaNode | string) => typeof k !== "string" && !!k.collapsed && !!k.el;
      let i = 0;
      while (i < kids.length && isFolded(kids[i])) i++;
      let j = kids.length;
      while (j > i && isFolded(kids[j - 1])) j--;
      flat.push(...kids.slice(0, i));
      if (j > i) {
        c.children = kids.slice(i, j);
        flat.push(c);
      }
      flat.push(...kids.slice(j));
    }
    const out: (AriaNode | string)[] = [];
    let run: AriaNode[] = [];
    const flush = () => {
      if (run.length < 2) {
        out.push(...run);
        run = [];
        return;
      }
      const lca = lowestCommonAncestor(run.map((r) => r.el!).filter(Boolean));
      const g: AriaNode = { role: "group", name: "", props: [], children: [], interactive: false, keep: false, el: lca ?? undefined, group: true };
      let refs = 0;
      for (const r of run) refs += refCountOf(r.collapsed);
      const first = run[0].collapsed!.split(" · ")[1] || run[0].name;
      const startEl = firstElementOf(run[0]);
      if (lca && startEl) g.start = startEl; // ref assigned once the final tree is known
      bctx.collapsed -= run.length - 1;
      g.collapsed = `${refs} refs in ${run.length} folded blocks${first ? ` · starts at: ${cut(first.replace(/^starts at: /, ""), 60)}` : ""}`;
      out.push(g);
      run = [];
    };
    for (const c of flat) {
      if (typeof c !== "string" && c.collapsed && c.el) run.push(c);
      else {
        flush();
        out.push(c);
      }
    }
    flush();
    return out;
  }

  const CHUNK = 8;

  /** Split long sibling runs into transparent chunks so far parts of one big list can fold. */
  function chunkLongRuns(n: AriaNode): void {
    for (const c of n.children) if (typeof c !== "string") chunkLongRuns(c);
    let nodes = 0;
    for (const c of n.children) if (typeof c !== "string" && c.el) nodes++;
    if (nodes <= CHUNK * 2) return;
    const out: (AriaNode | string)[] = [];
    let cur: (AriaNode | string)[] = [];
    let curNodes = 0;
    const flush = () => {
      if (!cur.length) return;
      const els = cur.filter((c): c is AriaNode => typeof c !== "string" && !!c.el).map((c) => c.el!);
      if (els.length < 2) out.push(...cur);
      else out.push({ role: "group", name: "", props: [], children: cur, interactive: false, keep: false, el: lowestCommonAncestor(els) ?? undefined, group: true, span: true });
      cur = [];
      curNodes = 0;
    };
    for (const c of n.children) {
      cur.push(c);
      if (typeof c !== "string" && c.el && ++curNodes >= CHUNK) flush();
    }
    flush();
    n.children = out;
  }

  function fitBudget(top: AriaNode, budget: number, interactiveOnly: boolean, bctx: BudgetCtx): void {
    let size = renderedLength(top.children);
    if (size <= budget) return;
    top.children = tidyForBudget(top.children, interactiveOnly);
    size = renderedLength(top.children);
    if (size > budget) chunkLongRuns(top);
    const vh = Math.max(1, bctx.bandBottom - bctx.bandTop);
    for (let round = 0; round < 4 && size > budget; round++) {
      // Candidates with estimated rendered cost and distance (in screens) from the band.
      const cands: Cand[] = [];
      const visitC = (n: AriaNode, parent: Cand | null, depth: number): number => {
        const c: Cand | null = n.el && !n.collapsed ? { node: n, parent, cost: 0, dist: 0, depth, y: 0 } : null;
        const childDepth = n.group ? depth : depth + 1;
        let cost = n.group ? 0 : lineCost(n, depth);
        for (const k of n.children) {
          if (typeof k === "string") cost += depth * 2 + 10 + k.length;
          else cost += visitC(k, c ?? parent, childDepth);
        }
        if (c) {
          c.cost = cost;
          const r = nodeRect(n);
          // Above the band (already scrolled past) folds before the same distance below.
          if (r) c.y = r.top - bctx.bandTop;
          if (r) c.dist = r.top > bctx.bandBottom ? (r.top - bctx.bandBottom) / vh : r.bottom < bctx.bandTop ? ((bctx.bandTop - r.bottom) / vh) * 2 + (bctx.aboveFirst ? 1e6 : 0) : 0;
          if (cost >= (round < 2 ? 160 : 60) && !containsFocus(n, bctx.focused)) cands.push(c);
        }
        return cost;
      };
      for (const k of top.children) if (typeof k !== "string") visitC(k, null, 0);
      const folded = new Set<Cand>();
      const underFolded = (c: Cand) => {
        for (let p: Cand | null = c.parent; p; p = p.parent) if (folded.has(p)) return true;
        return false;
      };
      let excess = size - budget;
      // 1) Off-screen first: farthest band first, then biggest (outermost wins ties).
      const far = cands.filter((c) => c.dist > 0).sort((a, b) => Math.floor(b.dist) - Math.floor(a.dist) || b.cost - a.cost);
      // 2) Only once everything off-screen is folded (and runs merged): on-screen bulk,
      //    biggest first, never more than half the page in one fold.
      // On-screen: bottom of the screen folds first; the top (what the agent sees first) stays.
      const near = round === 0 ? [] : cands.filter((c) => c.dist === 0 && c.cost <= size / 2).sort((a, b) => b.y - a.y || b.cost - a.cost);
      for (const c of [...far, ...near]) {
        if (excess <= 0) break;
        if (folded.has(c) || underFolded(c)) continue;
        // On screen, fold no more than needed: skip units much bigger than the remaining excess.
        if (c.dist === 0 && c.cost > excess + 600) continue;
        // Chunks of one run merge into a single line afterwards: count their full cost.
        const saving = c.node.span ? c.cost - 4 : c.cost - (lineCost(c.node, c.depth) + 60);
        if (saving <= 0) continue;
        // Folding a container whose folded descendants already pay for themselves is wasteful; ok—descendants are skipped below.
        collapseNode(c.node, bctx);
        folded.add(c);
        excess -= saving;
      }
      top.children = mergeCollapsedRuns(top.children, bctx);
      size = renderedLength(top.children);
    }
    const assign = (nodes: (AriaNode | string)[]) => {
      for (const n of nodes) {
        if (typeof n === "string") continue;
        if (n.collapsed && n.start && n.el && !n.ref) n.ref = runRef(n.el, n.start, bctx);
        else assign(n.children);
      }
    };
    assign(top.children);
  }

  // ---------------------------------------------------------------------------
  // YAML rendering
  // ---------------------------------------------------------------------------

  function yamlQuote(s: string): string {
    return JSON.stringify(s);
  }

  function yamlText(s: string): string {
    // Plain scalar when safe, otherwise JSON-quoted.
    if (/^[\w -￿(][^\n:#"'`{}[\]&*!|>%@]*$/.test(s) && !/\s$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^[-+]?\d/.test(s)) return s;
    return yamlQuote(s);
  }

  function header(n: AriaNode): string {
    let line = n.role;
    if (n.name) line += " " + yamlQuote(n.name);
    if (n.ref) line += ` [ref=${n.ref}]`;
    for (const p of n.props) line += ` [${p}]`;
    return line;
  }

  function render(nodes: (AriaNode | string)[], indent: string, out: string[]): void {
    for (const n of nodes) {
      if (typeof n === "string") {
        out.push(`${indent}- text: ${yamlText(n)}`);
        continue;
      }
      if (n.group && !n.collapsed) {
        render(n.children, indent, out);
        continue;
      }
      const h = header(n);
      if (n.collapsed) {
        out.push(`${indent}- ${h} [collapsed]: ${yamlText(n.collapsed)}`);
        continue;
      }
      const kids = n.children;
      if (!kids.length) {
        out.push(n.value !== undefined ? `${indent}- ${h}: ${yamlText(n.value)}` : `${indent}- ${h}`);
      } else if (kids.length === 1 && typeof kids[0] === "string" && n.value === undefined) {
        out.push(`${indent}- ${h}: ${yamlText(kids[0] as string)}`);
      } else {
        out.push(`${indent}- ${h}:`);
        if (n.value !== undefined) out.push(`${indent}  - /value: ${yamlText(n.value)}`);
        render(kids, indent + "  ", out);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function nthFingerprints(refNodes: { ref: string; role: string; name: string }[]): void {
    const counts = new Map<string, number>();
    for (const r of refNodes) {
      const key = `${r.role}\u0000${r.name}`;
      const nth = counts.get(key) ?? 0;
      counts.set(key, nth + 1);
      fingerprintOfRef.set(r.ref, { role: r.role, name: r.name, nth });
    }
    if (fingerprintOfRef.size > 20000) {
      // Bound memory on long-lived SPAs: drop fingerprints of refs whose element is gone.
      for (const [ref] of fingerprintOfRef) {
        const el = elementOfRef.get(ref)?.deref();
        if (!el || !el.isConnected) {
          fingerprintOfRef.delete(ref);
          elementOfRef.delete(ref);
        }
      }
    }
  }

  function takeSnapshot(opts: TakeSnapshotOptions): InjectedSnapshot {
    resetCaches();
    currentOrdinal = opts.frameOrdinal || 0;
    let root: Element | null = document.documentElement;
    if (opts.selector) {
      root = document.querySelector(opts.selector);
      if (!root) throw new Error(`selector_not_found: ${opts.selector}`);
    } else if (opts.ref) {
      root = deref(opts.ref);
      if (!root) throw new Error(`stale_ref: ${opts.ref}`);
    }
    const run = opts.ref ? runOfRef.get(opts.ref) : undefined;
    const runStart = run?.start.deref();
    const ctx: WalkCtx = {
      interactiveOnly: !!opts.interactive,
      showHidden: !!opts.showHidden,
      maxDepth: opts.maxDepth ?? 50,
      iframes: [],
      owned: new Set(),
      refNodes: [],
      focused: deepActiveElement(),
    };
    // aria-owns targets render under their owner, not in place.
    for (const o of Array.from(document.querySelectorAll("[aria-owns]"))) {
      for (const id of (o.getAttribute("aria-owns") || "").split(/\s+/)) {
        const t = id ? document.getElementById(id) : null;
        if (t && !o.contains(t)) ctx.owned.add(t);
      }
    }
    const top: AriaNode = { role: "fragment", name: "", props: [], children: [], interactive: false, keep: true };
    if (root) {
      if (opts.ref || opts.selector) visit(root, top, 0, ctx);
      else for (const c of childNodesOf(root)) visit(c, top, 0, ctx);
    }
    const budget = opts.budget && opts.budget > 0 ? opts.budget : 0;
    const compacted: (AriaNode | string)[] = [];
    for (const c of top.children) {
      if (typeof c === "string") {
        if (!ctx.interactiveOnly) compacted.push(c);
      } else compacted.push(...compact(c, ctx.interactiveOnly, budget > 0));
    }
    top.children = compacted;
    normalizeChildren(top);
    if (!ctx.interactiveOnly) cleanChildren(top);
    let collapsed = 0;
    if (budget) {
      let bandTop = 0;
      let bandBottom = window.innerHeight || document.documentElement.clientHeight || 900;
      if ((opts.ref || opts.selector) && root) {
        // Scoped: the "screen" starts at the scope root — or, for a folded run, at the run's first item.
        const r = (runStart && runStart.isConnected ? runStart : root).getBoundingClientRect();
        bandBottom = r.top + (bandBottom - bandTop);
        bandTop = r.top;
      }
      const bctx: BudgetCtx = { bandTop, bandBottom, focused: ctx.focused, refNodes: ctx.refNodes, collapsed: 0, aboveFirst: !!(runStart && runStart.isConnected) };
      fitBudget(top, budget, ctx.interactiveOnly, bctx);
      collapsed = bctx.collapsed;
    }
    const lines: string[] = [];
    render(top.children, "", lines);
    nthFingerprints(ctx.refNodes);
    // Uniqueness assertion (cheap).
    const seen = new Set<string>();
    for (const r of ctx.refNodes) {
      if (seen.has(r.ref)) throw new Error(`duplicate_ref: ${r.ref}`);
      seen.add(r.ref);
    }
    styleCache = new Map();
    return {
      yaml: lines.join("\n"),
      refs: ctx.refNodes.length,
      iframes: ctx.iframes,
      collapsed,
      title: document.title,
      url: location.href,
    };
  }

  function* allElementsDeep(root: Document | ShadowRoot | Element, budget: { n: number }): Generator<Element> {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let cur = walker.currentNode as Element | null;
    if (cur && cur.nodeType !== 1) cur = walker.nextNode() as Element | null;
    while (cur) {
      if (budget.n-- <= 0) return;
      yield cur;
      const sr = shadowOf(cur);
      if (sr) yield* allElementsDeep(sr, budget);
      cur = walker.nextNode() as Element | null;
    }
  }

  function deref(ref: string): Element | null {
    const el = elementOfRef.get(ref)?.deref();
    if (el && el.isConnected) return el;
    const fp = fingerprintOfRef.get(ref);
    if (!fp) return null;
    // Fallback: role + name + nth over ≤ 5000 nodes.
    resetCaches();
    let nth = 0;
    for (const cand of allElementsDeep(document, { n: 5000 })) {
      if (getRole(cand) !== fp.role) continue;
      if (!isVisible(cand)) continue;
      if (accessibleName(cand, fp.role) !== fp.name) continue;
      if (nth === fp.nth) {
        elementOfRef.set(ref, new WeakRef(cand));
        refOfElement.set(cand, { ref, role: fp.role, name: fp.name });
        return cand;
      }
      nth++;
    }
    return null;
  }

  function rectOf(el: Element): Rect {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function checkEditable(ref: string): boolean {
    const el = deref(ref);
    if (!el) return false;
    return isEditableElement(el);
  }

  function isEditableElement(el: Element): boolean {
    if (isDisabled(el)) return false;
    if (el.tagName === "INPUT") {
      const t = (el as HTMLInputElement).type;
      if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"].includes(t)) return false;
      return !(el as HTMLInputElement).readOnly;
    }
    if (el.tagName === "TEXTAREA") return !(el as HTMLTextAreaElement).readOnly;
    if (el.tagName === "SELECT") return true;
    if ((el as HTMLElement).isContentEditable) return true;
    return el.getAttribute("aria-readonly") !== "true" && ["textbox", "searchbox", "combobox", "spinbutton"].includes(el.getAttribute("role") || "") && (el as HTMLElement).isContentEditable;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForReady(
    ref: string,
    opts: { timeoutMs: number; enabled?: boolean; editable?: boolean },
  ): Promise<{ ok: true; rect: Rect } | { ok: false; reason: ReadyFailure }> {
    const deadline = Date.now() + Math.max(0, opts.timeoutMs);
    const backoff = [0, 100, 200];
    let attempt = 0;
    let reason: ReadyFailure = "timeout";
    for (;;) {
      const wait = backoff[Math.min(attempt, backoff.length - 1)] ?? 200;
      if (attempt > 0) await sleep(wait);
      attempt++;
      resetCaches();
      const el = deref(ref);
      if (!el) reason = "detached";
      else if (!isVisibleForAction(el)) reason = "hidden";
      else if (opts.enabled !== false && isDisabled(el)) reason = "disabled";
      else if (opts.editable && !isEditableElement(el)) reason = "not_editable";
      else {
        const a = rectOf(el);
        await sleep(32); // setTimeout, not rAF: works in throttled background tabs
        if (!el.isConnected) reason = "detached";
        else {
          const b = rectOf(el);
          if (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height) return { ok: true, rect: b };
          reason = "unstable";
        }
      }
      if (Date.now() >= deadline) return { ok: false, reason };
    }
  }

  function isVisibleForAction(el: Element): boolean {
    // Walk up through shadow hosts for display:none / visibility.
    let cur: Element | null = el;
    while (cur) {
      if (style(cur).display === "none") return false;
      cur = parentElementComposed(cur);
    }
    if (style(el).visibility !== "visible") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function describeHit(hit: Element | null): string | undefined {
    if (!hit) return undefined;
    const info = refOfElement.get(hit);
    if (info) return info.ref;
    let s = hit.tagName.toLowerCase();
    if (hit.id) s += `#${hit.id}`;
    const cls = (hit.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    return s;
  }

  function checkHitTarget(ref: string, x: number, y: number): { ok: boolean; hit?: string } {
    const el = deref(ref);
    if (!el) return { ok: false };
    const hit = deepElementFromPoint(x, y);
    if (!hit) return { ok: false };
    if (containsComposed(el, hit)) return { ok: true };
    // Clicking a label activates its control.
    const labels = (el as HTMLInputElement).labels;
    if (labels) for (const l of Array.from(labels)) if (containsComposed(l, hit)) return { ok: true };
    // Hit inside a wrapping label of the target.
    const lab = hit.closest?.("label");
    if (lab && (lab as HTMLLabelElement).control === el) return { ok: true };
    return { ok: false, hit: describeHit(hit) };
  }

  function resolvePointerTarget(x: number, y: number): { ref?: string; tag: string } {
    const hit = deepElementFromPoint(x, y);
    if (!hit) return { tag: "" };
    let cur: Element | null = hit;
    while (cur) {
      const info = refOfElement.get(cur);
      if (info && elementOfRef.get(info.ref)?.deref() === cur) return { ref: info.ref, tag: hit.tagName.toLowerCase() };
      cur = parentElementComposed(cur);
    }
    return { tag: hit.tagName.toLowerCase() };
  }

  // Mutation tracking for settleProbe.
  let mutatedSinceProbe = 0;
  try {
    const mo = new MutationObserver((records) => {
      mutatedSinceProbe += records.length;
    });
    mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* document not ready */
  }

  const INTERACTIVE_SELECTOR =
    "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[onclick],[tabindex]:not([tabindex='-1']),[contenteditable='true'],[contenteditable='']";

  function settleProbe(): SettleProbe {
    resetCaches();
    const all = document.getElementsByTagName("*").length || 1;
    let interactiveCount = 0;
    const cands = document.querySelectorAll(INTERACTIVE_SELECTOR);
    const lim = Math.min(cands.length, 3000);
    for (let i = 0; i < lim; i++) {
      const r = cands[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) interactiveCount++;
    }
    const textLen = Math.min((document.body?.textContent || "").length, 1_000_000);
    const landmarks = document.querySelectorAll("main,nav,header,footer,aside,[role=main],[role=navigation],[role=banner],[role=contentinfo],[role=search],form[aria-label],section[aria-label]").length;
    const ratio = Math.min(1, mutatedSinceProbe / all);
    mutatedSinceProbe = 0;
    return { readyState: document.readyState, interactiveCount, textLen, mutationRatio: ratio, landmarks };
  }

  // Set-of-marks overlay.
  let overlay: HTMLElement | null = null;
  function annotate(on: boolean): void {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (!on) return;
    resetCaches();
    const host = document.createElement("obu-annotations");
    host.setAttribute("style", "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;");
    const root = host.attachShadow({ mode: "closed" });
    const vw = innerWidth;
    const vh = innerHeight;
    const frag = document.createDocumentFragment();
    for (const [ref, wr] of elementOfRef) {
      const el = wr.deref();
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) continue;
      if (!isVisibleForAction(el)) continue;
      const box = document.createElement("div");
      box.setAttribute("style", `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #e11;box-sizing:border-box;`);
      const label = document.createElement("div");
      label.textContent = ref;
      label.setAttribute("style", `position:fixed;left:${Math.max(0, r.left)}px;top:${Math.max(0, r.top - 14)}px;background:#e11;color:#fff;font:bold 11px/14px monospace;padding:0 3px;`);
      frag.append(box, label);
    }
    root.append(frag);
    (document.documentElement || document.body).appendChild(host);
    overlay = host;
  }

  /** Ref of a given element (used by the daemon to map frame owners to placeholders). */
  function refOf(el: Element): string | null {
    const info = refOfElement.get(el);
    return info && elementOfRef.get(info.ref)?.deref() === el ? info.ref : null;
  }

  /** Daemon hands us a closed shadow root (resolved via CDP) so walks can enter it. */
  function registerClosedRoot(root: ShadowRoot): boolean {
    if (!root || root.nodeType !== 11 || !(root as ShadowRoot).host) return false;
    closedRoots.set((root as ShadowRoot).host, root);
    return true;
  }

  const REPLACED = new Set(["IMG", "INPUT", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "FRAME", "SVG", "svg", "BR", "HR", "TEXTAREA", "SELECT", "OBJECT", "EMBED", "PICTURE", "SOURCE", "TRACK", "WBR", "SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "SLOT", "PATH"]);
  /**
   * Elements that may host a closed shadow root we cannot see: custom elements
   * without a reachable root, or empty non-replaced elements that still have a
   * box (content must come from somewhere). Capped; 0 → daemon skips the CDP pass.
   */
  function closedRootCandidates(): number {
    let n = 0;
    let scanned = 0;
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (n >= 50 || ++scanned > 20000) break;
      if (shadowOf(el) || REPLACED.has(el.tagName)) continue;
      if (el.localName.includes("-")) {
        n++;
        continue;
      }
      if (el.firstChild) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) n++;
    }
    return n;
  }

  const api: ObuInjectedApi = {
    version: VERSION,
    takeSnapshot,
    deref,
    waitForReady,
    checkHitTarget,
    resolvePointerTarget,
    checkEditable,
    settleProbe,
    annotate,
    refOf,
    registerClosedRoot,
    closedRootCandidates,
  };
  Object.defineProperty(g, "__obu", { value: api, configurable: true, enumerable: false, writable: true });
}
