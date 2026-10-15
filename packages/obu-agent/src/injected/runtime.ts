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

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "BASE"]);

  // ---------------------------------------------------------------------------
  // Per-snapshot caches
  // ---------------------------------------------------------------------------

  let styleCache = new Map<Element, CSSStyleDeclaration>();
  let hiddenCache = new Map<Element, boolean>();
  let nameCache = new Map<Element, string>();
  let roleCache = new Map<Element, string>();

  function resetCaches(): void {
    styleCache = new Map();
    hiddenCache = new Map();
    nameCache = new Map();
    roleCache = new Map();
    textVisCache = new Map();
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
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
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
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        // Zero-size boxes can still show overflow children; treat as visible
        // only if a child has a box.
        hidden = !Array.from(el.children).some((c) => {
          const cr = c.getBoundingClientRect();
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
    return false;
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
      if (el.shadowRoot) children.push(...Array.from(el.shadowRoot.childNodes));
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
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }

  function childNodesOf(el: Element | Document | ShadowRoot): Node[] {
    if ((el as Element).shadowRoot) return Array.from((el as Element).shadowRoot!.childNodes);
    if ((el as Element).tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(el.childNodes);
    }
    return Array.from(el.childNodes);
  }

  function shortUrl(href: string): string {
    try {
      const u = new URL(href, location.href);
      if (u.protocol === "javascript:") return "";
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

  /** Returns replacement nodes for `n` (unwrapping, dropping). */
  function compact(n: AriaNode, interactiveOnly: boolean): (AriaNode | string)[] {
    const kids: (AriaNode | string)[] = [];
    for (const c of n.children) {
      if (typeof c === "string") kids.push(c);
      else kids.push(...compact(c, interactiveOnly));
    }
    n.children = kids;
    normalizeChildren(n);

    if (interactiveOnly) {
      // Keep only refs, landmarks, headings and dialogs (+ their ancestors).
      const hasKeptDesc = n.children.some((c) => typeof c !== "string");
      if (!n.keep) return n.children;
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
      return n.children;
    }
    if (n.role === "generic" && !n.ref && !n.name && n.props.length === 1 && n.props[0] === "scrollable" && !n.children.length) {
      return [];
    }
    if ((n.role === "list" || n.role === "group" || n.role === "rowgroup" || n.role === "figure" || n.role === "label" || n.role === "strong" || n.role === "emphasis" || n.role === "code" || n.role === "status") && !n.ref && !n.name && !n.props.length) {
      if (!n.children.length) return [];
      if (n.role === "rowgroup" || n.role === "label" || n.role === "strong" || n.role === "emphasis" || n.role === "status") return n.children;
      if (n.role === "code" && n.children.every((c) => typeof c === "string")) return n.children;
    }
    if (!n.ref && !n.name && !n.children.length && !n.props.length && n.role !== "separator" && n.role !== "img") return [];
    return [n];
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
      const h = header(n);
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
    const compacted: (AriaNode | string)[] = [];
    for (const c of top.children) {
      if (typeof c === "string") {
        if (!ctx.interactiveOnly) compacted.push(c);
      } else compacted.push(...compact(c, ctx.interactiveOnly));
    }
    top.children = compacted;
    normalizeChildren(top);
    if (!ctx.interactiveOnly) cleanChildren(top);
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
      if (cur.shadowRoot) yield* allElementsDeep(cur.shadowRoot, budget);
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
  };
  Object.defineProperty(g, "__obu", { value: api, configurable: true, enumerable: false, writable: true });
}
