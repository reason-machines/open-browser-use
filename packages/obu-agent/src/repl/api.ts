// r2-repl: a Playwright-compatible subset bound to the daemon's own handler
// table, so REPL code and the fat tools share one action/settle/snapshot layer.
// Every call goes through `call(method, params)`, which injects the sessionId.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { inspect } from "node:util";
import type {
  ActParams,
  ActResult,
  DownloadInfo,
  NavigateResult,
  Ref,
  ScreenshotResult,
  SnapshotResult,
  SystemEvent,
  TabId,
  TabsOpenResult,
  WaitResult,
} from "../contract.js";
import { ObuError } from "../errors.js";

export type ReplCall = (method: string, params: Record<string, unknown>) => Promise<any>;

export interface ReplHost {
  call: ReplCall;
  /** Session artefact root; the REPL's `./artifacts`. */
  artifactsDir: string;
  /** Collected by the cell: steering events and images to show the model. */
  events: SystemEvent[];
  images: { path: string; mime: string }[];
  warnings: string[];
}

const REF_RE = /^(?:f\d+)?e\d+$/;

/** Resolve a path the agent passed into the artifacts dir (no escaping it). */
export function artifactPath(host: ReplHost, path: string): string {
  const root = resolve(host.artifactsDir);
  const cleaned = path.replace(/^\.\/artifacts\/?/, "").replace(/^artifacts\//, "");
  const full = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ObuError("invalid_params", `files can only be written/read under ./artifacts (${root}); got ${path}`);
  }
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

function collect(host: ReplHost, result: any): any {
  if (result && Array.isArray(result.events)) host.events.push(...result.events);
  if (result && Array.isArray(result.warnings)) host.warnings.push(...result.warnings);
  return result;
}

// ---------------------------------------------------------------------------
// Snapshot value: prints as the aria tree (plus diff) in console.log.

export class Snapshot {
  constructor(
    readonly tree: string,
    readonly diff: string,
    readonly url: string,
    readonly title: string,
    readonly tabId: TabId,
  ) {}
  toString(): string {
    return this.tree;
  }
  [inspect.custom](): string {
    return this.diff ? `${this.tree}\n--- diff vs previous snapshot ---\n${this.diff}` : this.tree;
  }
  /** Refs of lines matching role (+ optional name substring / exact). */
  find(role: string | undefined, name?: string | RegExp, exact = false): { ref?: Ref; role: string; name: string }[] {
    const out: { ref?: Ref; role: string; name: string }[] = [];
    for (const line of this.tree.split("\n")) {
      const m = /^\s*-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/.exec(line);
      if (!m) continue;
      const lineRole = m[1]!;
      const lineName = (m[2] ?? "").replace(/\\"/g, '"');
      const refMatch = /\[ref=([^\]]+)\]/.exec(m[3] ?? "");
      if (role && lineRole !== role) continue;
      if (name !== undefined) {
        if (name instanceof RegExp) {
          if (!name.test(lineName)) continue;
        } else if (exact ? lineName !== name : !lineName.toLowerCase().includes(name.toLowerCase())) {
          continue;
        }
      }
      out.push({ ref: refMatch?.[1], role: lineRole, name: lineName });
    }
    return out;
  }
}

function toSnapshot(r: SnapshotResult): Snapshot {
  return new Snapshot(r.tree, r.diff ?? "", r.url, r.title, r.tabId);
}

// ---------------------------------------------------------------------------
// Locators (lazy, like Playwright): resolved to ref | selector at action time.

type LocatorSpec =
  | { kind: "css"; selector: string; nth?: number }
  | { kind: "ref"; ref: Ref }
  | { kind: "role"; role: string; name?: string | RegExp; exact?: boolean; nth?: number }
  | { kind: "text"; text: string | RegExp; exact?: boolean; nth?: number };

type ActTarget = { ref?: Ref; selector?: string };

export class Locator {
  constructor(
    private readonly page: Page,
    private readonly spec: LocatorSpec,
  ) {}

  nth(index: number): Locator {
    if (this.spec.kind === "ref") return this;
    return new Locator(this.page, { ...this.spec, nth: index });
  }
  first(): Locator {
    return this.nth(0);
  }
  last(): Locator {
    return this.nth(-1);
  }
  locator(selector: string): Locator {
    if (this.spec.kind !== "css") throw new ObuError("invalid_params", "chained .locator() is only supported on CSS locators");
    return new Locator(this.page, { kind: "css", selector: `${this.spec.selector} ${selector}` });
  }
  toString(): string {
    return `Locator(${JSON.stringify(this.spec)})`;
  }
  [inspect.custom](): string {
    return this.toString();
  }

  /** @internal */
  async target(): Promise<ActTarget> {
    const spec = this.spec;
    if (spec.kind === "ref") return { ref: spec.ref };
    if (spec.kind === "css") {
      if (spec.nth === undefined || spec.nth === 0) return { selector: spec.selector };
      return { ref: await this.page._refOfCss(spec.selector, spec.nth) };
    }
    const matches = await this.matches();
    const index = spec.nth === undefined ? 0 : spec.nth < 0 ? matches.length + spec.nth : spec.nth;
    const hit = matches[index];
    if (!hit) {
      if (spec.kind === "text") {
        // Plain text (not an interactive element): let the action layer find it.
        if (typeof spec.text === "string" && (spec.nth ?? 0) === 0) return { selector: `text=${spec.text}` };
      }
      throw new ObuError("not_actionable", `${this} matched nothing on the page (${matches.length} matches). Take a snapshot() and use a ref.`, { reason: "detached" });
    }
    if (!hit.ref) throw new ObuError("not_actionable", `${this} matched ${hit.role} "${hit.name}", which is not interactive (no ref).`, { reason: "not_editable" });
    return { ref: hit.ref };
  }

  private async matches(): Promise<{ ref?: Ref; role: string; name: string }[]> {
    const snap = await this.page._resolveSnapshot();
    const spec = this.spec;
    if (spec.kind === "role") return snap.find(spec.role, spec.name, spec.exact);
    if (spec.kind === "text") return snap.find(undefined, spec.text, spec.exact).filter((m) => m.ref);
    return [];
  }

  async count(): Promise<number> {
    const spec = this.spec;
    if (spec.kind === "ref") return 1;
    if (spec.kind === "css") return (await this.page.evaluate(`document.querySelectorAll(${JSON.stringify(spec.selector)}).length`)) as number;
    return (await this.matches()).length;
  }
  async all(): Promise<Locator[]> {
    const n = await this.count();
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  async click(opts: ClickOptions = {}): Promise<void> {
    await this.page._act(opts.clickCount === 2 ? "dblclick" : "click", await this.target(), clickExtras(opts));
  }
  async dblclick(opts: ClickOptions = {}): Promise<void> {
    await this.page._act("dblclick", await this.target(), clickExtras(opts));
  }
  async hover(): Promise<void> {
    await this.page._act("hover", await this.target());
  }
  async fill(value: string): Promise<void> {
    await this.page._act("fill", await this.target(), { value });
  }
  async clear(): Promise<void> {
    await this.fill("");
  }
  async type(text: string): Promise<void> {
    await this.page._act("type", await this.target(), { value: text });
  }
  async pressSequentially(text: string): Promise<void> {
    await this.type(text);
  }
  async press(keys: string): Promise<void> {
    await this.page._act("press", await this.target(), { keys });
  }
  async check(): Promise<void> {
    await this.page._act("check", await this.target());
  }
  async uncheck(): Promise<void> {
    await this.page._act("uncheck", await this.target());
  }
  async setChecked(checked: boolean): Promise<void> {
    await (checked ? this.check() : this.uncheck());
  }
  async selectOption(values: string | string[]): Promise<void> {
    await this.page._act("select", await this.target(), { value: values });
  }
  async setInputFiles(files: string | string[]): Promise<void> {
    const list = (Array.isArray(files) ? files : [files]).map((f) => this.page._inputFile(f));
    await this.page._act("upload", await this.target(), { files: list });
  }
  async dragTo(other: Locator): Promise<void> {
    await this.page._act("drag", await this.target(), { to: await other.target() });
  }
  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.page._evalOn(await this.target(), "el => el.scrollIntoView({block:'center'})");
  }
  async textContent(): Promise<string | null> {
    return (await this.page._evalOn(await this.target(), "el => el.textContent")) as string | null;
  }
  async innerText(): Promise<string> {
    return (await this.page._evalOn(await this.target(), "el => el.innerText ?? el.textContent ?? ''")) as string;
  }
  async inputValue(): Promise<string> {
    return (await this.page._evalOn(await this.target(), "el => el.value ?? ''")) as string;
  }
  async getAttribute(name: string): Promise<string | null> {
    return (await this.page._evalOn(await this.target(), `el => el.getAttribute(${JSON.stringify(name)})`)) as string | null;
  }
  async isVisible(): Promise<boolean> {
    try {
      return (await this.page._evalOn(await this.target(), "el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }")) as boolean;
    } catch (error) {
      if (error instanceof ObuError && (error.code === "not_actionable" || error.code === "stale_ref")) return false;
      throw error;
    }
  }
  async isChecked(): Promise<boolean> {
    return (await this.page._evalOn(await this.target(), "el => el.checked === true || el.getAttribute('aria-checked') === 'true'")) as boolean;
  }
  async evaluate(fn: string | ((el: Element, arg: unknown) => unknown), arg?: unknown): Promise<unknown> {
    return this.page._evalOn(await this.target(), typeof fn === "function" ? fn.toString() : fn, arg);
  }
  async waitFor(opts: { state?: "visible" | "attached"; timeout?: number } = {}): Promise<void> {
    const deadline = Date.now() + (opts.timeout ?? 30_000);
    for (;;) {
      const ok = opts.state === "attached" ? (await this.count()) > 0 : await this.isVisible();
      if (ok) return;
      if (Date.now() > deadline) throw new ObuError("timeout", `${this} not ${opts.state ?? "visible"} within ${opts.timeout ?? 30_000} ms`, { stage: "locator.waitFor" });
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  async screenshot(opts: { path?: string } = {}): Promise<Buffer> {
    const target = await this.target();
    if (!target.ref) throw new ObuError("invalid_params", "locator.screenshot needs a ref-resolvable locator (use a ref or getByRole)");
    return this.page.screenshot({ ...opts, ref: target.ref });
  }
}

interface ClickOptions {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: ActParams["modifiers"];
  timeout?: number;
}
function clickExtras(opts: ClickOptions): Partial<ActParams> {
  return {
    ...(opts.button ? { button: opts.button } : {}),
    ...(opts.modifiers ? { modifiers: opts.modifiers } : {}),
    ...(opts.timeout ? { timeoutMs: opts.timeout } : {}),
  };
}

// ---------------------------------------------------------------------------
// Download handle (Playwright-like).

export class Download {
  #local: string | undefined;
  constructor(
    private readonly info: DownloadInfo,
    private readonly page: Page,
  ) {}
  /**
   * Local path of the finished file. When the browser did not report one (no
   * download-path resolver on this backend), the file is re-fetched in the page
   * (same cookies) into ./artifacts/downloads/.
   */
  async path(): Promise<string> {
    if (this.info.path && existsSync(this.info.path)) return this.info.path;
    if (this.#local) return this.#local;
    const b64 = (await this.page.evaluate(
      `(async () => { const r = await fetch(${JSON.stringify(this.info.url)}, { credentials: "include" }); if (!r.ok) throw new Error("re-fetch failed: HTTP " + r.status); const b = new Uint8Array(await r.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); })()`,
    )) as string;
    const full = artifactPath(this.page.host, `downloads/${this.suggestedFilename()}`);
    writeFileSync(full, Buffer.from(b64, "base64"));
    this.page.host.warnings.push(`download path not reported by the browser; re-fetched ${this.info.url} in the page into ${full}`);
    this.#local = full;
    return full;
  }
  suggestedFilename(): string {
    if (this.info.path) return basename(this.info.path);
    try {
      return basename(new URL(this.info.url).pathname) || "download";
    } catch {
      return "download";
    }
  }
  url(): string {
    return this.info.url;
  }
  get bytes(): number | undefined {
    return this.info.bytes;
  }
  get mime(): string | undefined {
    return this.info.mime;
  }
  /** Contents of the downloaded file. */
  async buffer(): Promise<Buffer> {
    return readFileSync(await this.path());
  }
  async text(): Promise<string> {
    return readFileSync(await this.path(), "utf8");
  }
  async saveAs(path: string): Promise<void> {
    copyFileSync(await this.path(), artifactPath(this.page.host, path));
  }
  [inspect.custom](): string {
    return `Download(${JSON.stringify(this.info)})`;
  }
}

// ---------------------------------------------------------------------------
// Page = one tab (or the session's active tab until the first goto).

export class Page {
  #tabId: TabId | undefined;
  #url = "";
  #title = "";
  readonly keyboard: { press(keys: string): Promise<void>; type(text: string): Promise<void>; insertText(text: string): Promise<void> };
  readonly mouse: { click(x: number, y: number, opts?: ClickOptions): Promise<void>; wheel(dx: number, dy: number): Promise<void>; move(x: number, y: number): Promise<void> };

  constructor(
    readonly context: BrowserContext,
    tabId?: TabId,
  ) {
    this.#tabId = tabId;
    context._adopt(this);
    this.keyboard = {
      press: async (keys) => void (await this._act("press", {}, { keys })),
      type: async (text) => void (await this._cdp("Input.insertText", { text })),
      insertText: async (text) => void (await this._cdp("Input.insertText", { text })),
    };
    this.mouse = {
      click: async (x, y, opts = {}) => void (await this._act(opts.clickCount === 2 ? "dblclick" : "click", {}, { coords: { x, y }, ...clickExtras(opts) })),
      move: async (x, y) => void (await this._act("hover", {}, { coords: { x, y } })),
      wheel: async (_dx, dy) => void (await this._act("scroll", {}, { value: dy < 0 ? "up" : "down" })),
    };
  }

  get host(): ReplHost {
    return this.context.host;
  }
  get tabId(): TabId | undefined {
    return this.#tabId;
  }
  /** Last known URL (sync, like Playwright). */
  url(): string {
    return this.#url;
  }
  async title(): Promise<string> {
    const v = (await this.evaluate("document.title")) as string;
    this.#title = v;
    return v;
  }
  [inspect.custom](): string {
    return `Page(tab ${this.#tabId ?? "?"} ${this.#url})`;
  }

  #tab(): Record<string, unknown> {
    return this.#tabId === undefined ? {} : { tabId: this.#tabId };
  }
  #track(result: any): any {
    collect(this.host, result);
    const snap = result?.snapshot;
    if (snap?.url) this.#url = snap.url;
    if (typeof result?.url === "string") this.#url = result.url;
    if (snap?.title) this.#title = snap.title;
    return result;
  }

  // -- navigation ------------------------------------------------------------

  async goto(url: string, opts: { waitUntil?: "settled" | "domcontentloaded" | "load" | "none" | "networkidle" | "commit" } = {}): Promise<{ url: string; title: string }> {
    const waitUntil = opts.waitUntil === "networkidle" ? "settled" : opts.waitUntil === "commit" ? "none" : opts.waitUntil;
    if (this.#tabId === undefined) {
      const active = await this.context._activeTabId();
      if (active === undefined) {
        const opened = this.#track((await this.host.call("tabs.open", { url })) as TabsOpenResult);
        this.#tabId = opened.tabId;
        this.#title = opened.title;
        return { url: opened.url, title: opened.title };
      }
      this.#tabId = active;
    }
    const r = this.#track((await this.host.call("navigate", { ...this.#tab(), url, ...(waitUntil ? { waitUntil } : {}), snapshot: "none" })) as NavigateResult);
    const info = (await this.evaluate("[location.href, document.title]")) as [string, string];
    this.#url = info[0];
    this.#title = info[1];
    return { url: info[0], title: info[1], ...(r.settled ? { settled: r.settled } : {}) } as { url: string; title: string };
  }
  async reload(): Promise<void> {
    this.#track(await this.host.call("navigate", { ...this.#tab(), op: "reload", snapshot: "none" }));
  }
  async goBack(): Promise<void> {
    this.#track(await this.host.call("navigate", { ...this.#tab(), op: "back", snapshot: "none" }));
  }
  async goForward(): Promise<void> {
    this.#track(await this.host.call("navigate", { ...this.#tab(), op: "forward", snapshot: "none" }));
  }

  // -- reading ---------------------------------------------------------------

  /** Aria snapshot of this page (refs `eN` / `fKeN`), diffed against your previous one. */
  async snapshot(opts: { interactive?: boolean; ref?: Ref; selector?: string; maxChars?: number } = {}): Promise<Snapshot> {
    const r = this.#track((await this.host.call("snapshot", { ...this.#tab(), ...opts })) as SnapshotResult);
    if (this.#tabId === undefined) this.#tabId = r.tabId;
    return toSnapshot(r);
  }
  /** @internal Snapshot for locator resolution: full tree, does not disturb the agent's diff baseline. */
  async _resolveSnapshot(): Promise<Snapshot> {
    const r = collect(this.host, await this.host.call("snapshot", { ...this.#tab(), selector: ":root", maxChars: 400_000 })) as SnapshotResult;
    return toSnapshot(r);
  }
  async content(): Promise<string> {
    return (await this.evaluate("document.documentElement.outerHTML")) as string;
  }
  async innerText(selector: string): Promise<string> {
    return this.locator(selector).innerText();
  }
  async textContent(selector: string): Promise<string | null> {
    return this.locator(selector).textContent();
  }
  async inputValue(selector: string): Promise<string> {
    return this.locator(selector).inputValue();
  }
  async getAttribute(selector: string, name: string): Promise<string | null> {
    return this.locator(selector).getAttribute(name);
  }
  async isVisible(selector: string): Promise<boolean> {
    return this.locator(selector).isVisible();
  }

  /**
   * Evaluate in the page. Default world is the isolated one (DOM shared, page JS
   * globals invisible, undetectable); pass {world:'page'} for page globals.
   */
  async evaluate(fn: string | ((arg: any) => unknown), arg?: unknown, opts: { world?: "isolated" | "page" } = {}): Promise<unknown> {
    const expression = typeof fn === "function" ? `(${fn.toString()})(${serializeArg(arg)})` : fn;
    const r = collect(this.host, await this.host.call("evaluate", { ...this.#tab(), expression, awaitPromise: true, world: opts.world ?? "isolated" }));
    return r.value;
  }
  async evaluateInPage(fn: string | ((arg: any) => unknown), arg?: unknown): Promise<unknown> {
    return this.evaluate(fn, arg, { world: "page" });
  }
  /** @internal evaluate a function with `el` bound to the target element. */
  async _evalOn(target: ActTarget, fnSource: string, arg?: unknown): Promise<unknown> {
    const finder = target.ref
      ? `globalThis.__obu && globalThis.__obu.deref(${JSON.stringify(target.ref)})`
      : `(${JSON.stringify(target.selector)}.startsWith("text=") ? [...document.querySelectorAll("body *")].find(n => [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.toLowerCase().includes(${JSON.stringify((target.selector ?? "").slice(5).trim().toLowerCase())}))) : document.querySelector(${JSON.stringify(target.selector)}))`;
    const expression = `(async () => { const el = ${finder}; if (!el) return { __missing: true }; return { value: await (${fnSource})(el, ${serializeArg(arg)}) }; })()`;
    const r = (await this.evaluate(expression)) as { __missing?: true; value?: unknown } | null;
    if (!r || r.__missing) {
      throw new ObuError(target.ref ? "stale_ref" : "not_actionable", target.ref ? `ref ${target.ref} is not on the page any more; take a fresh snapshot()` : `no element matches ${target.selector}`, { ...(target.ref ? { ref: target.ref } : { reason: "detached" }) });
    }
    return r.value;
  }
  /** @internal ref of the nth CSS match (snapshotting once if refs are not assigned yet). */
  async _refOfCss(selector: string, nth: number): Promise<Ref> {
    const expr = `(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); const el = all[${nth} < 0 ? all.length + ${nth} : ${nth}]; if (!el) return { missing: true, n: all.length }; return { ref: globalThis.__obu ? globalThis.__obu.refOf(el) : null }; })()`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = (await this.evaluate(expr)) as { missing?: boolean; n?: number; ref?: string | null };
      if (r.missing) throw new ObuError("not_actionable", `${selector} has ${r.n} matches; index ${nth} does not exist`, { reason: "detached" });
      if (r.ref) return r.ref;
      await this._resolveSnapshot();
    }
    throw new ObuError("not_actionable", `match ${nth} of ${selector} is not an interactive element (no ref)`, { reason: "not_editable" });
  }

  // -- locators --------------------------------------------------------------

  locator(selector: string): Locator {
    if (REF_RE.test(selector)) return new Locator(this, { kind: "ref", ref: selector });
    if (selector.startsWith("ref=")) return new Locator(this, { kind: "ref", ref: selector.slice(4) });
    const role = /^role=([a-z]+)(?:\[name=(["'])(.*)\2\])?$/i.exec(selector);
    if (role) return new Locator(this, { kind: "role", role: role[1]!, ...(role[3] !== undefined ? { name: role[3] } : {}) });
    if (selector.startsWith("text=")) return new Locator(this, { kind: "text", text: selector.slice(5) });
    return new Locator(this, { kind: "css", selector });
  }
  getByRole(role: string, opts: { name?: string | RegExp; exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "role", role, ...(opts.name !== undefined ? { name: opts.name } : {}), ...(opts.exact ? { exact: true } : {}) });
  }
  getByText(text: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "text", text, ...(opts.exact ? { exact: true } : {}) });
  }
  getByLabel(label: string | RegExp, opts: { exact?: boolean } = {}): Locator {
    return new Locator(this, { kind: "text", text: label, ...(opts.exact ? { exact: true } : {}) });
  }
  getByPlaceholder(text: string): Locator {
    return new Locator(this, { kind: "css", selector: `[placeholder*=${JSON.stringify(text)} i]` });
  }
  getByTestId(id: string): Locator {
    return new Locator(this, { kind: "css", selector: `[data-testid=${JSON.stringify(id)}]` });
  }

  // -- actions (selector string, ref or Locator) ----------------------------

  async #target(sel: string | Locator): Promise<ActTarget> {
    return (typeof sel === "string" ? this.locator(sel) : sel).target();
  }
  async click(sel: string | Locator, opts: ClickOptions = {}): Promise<void> {
    await this._act(opts.clickCount === 2 ? "dblclick" : "click", await this.#target(sel), clickExtras(opts));
  }
  async dblclick(sel: string | Locator, opts: ClickOptions = {}): Promise<void> {
    await this._act("dblclick", await this.#target(sel), clickExtras(opts));
  }
  async hover(sel: string | Locator): Promise<void> {
    await this._act("hover", await this.#target(sel));
  }
  async fill(sel: string | Locator, value: string): Promise<void> {
    await this._act("fill", await this.#target(sel), { value });
  }
  async type(sel: string | Locator, text: string): Promise<void> {
    await this._act("type", await this.#target(sel), { value: text });
  }
  async press(sel: string | Locator, keys: string): Promise<void> {
    await this._act("press", await this.#target(sel), { keys });
  }
  async check(sel: string | Locator): Promise<void> {
    await this._act("check", await this.#target(sel));
  }
  async uncheck(sel: string | Locator): Promise<void> {
    await this._act("uncheck", await this.#target(sel));
  }
  async selectOption(sel: string | Locator, values: string | string[]): Promise<void> {
    await this._act("select", await this.#target(sel), { value: values });
  }
  async setInputFiles(sel: string | Locator, files: string | string[]): Promise<void> {
    const list = (Array.isArray(files) ? files : [files]).map((f) => this._inputFile(f));
    await this._act("upload", await this.#target(sel), { files: list });
  }
  async dragAndDrop(source: string | Locator, target: string | Locator): Promise<void> {
    await this._act("drag", await this.#target(source), { to: await this.#target(target) });
  }
  /** Scroll the page (or an element) one step: 'up' | 'down' | 'left' | 'right'. */
  async scroll(direction: "up" | "down" | "left" | "right" = "down", sel?: string | Locator): Promise<void> {
    await this._act("scroll", sel ? await this.#target(sel) : {}, { value: direction });
  }

  /** @internal resolve an upload path: ./artifacts-relative or absolute. */
  _inputFile(path: string): string {
    if (isAbsolute(path)) return path;
    return artifactPath(this.host, path);
  }

  /** @internal one daemon `act` call (settles; no snapshot unless asked). */
  async _act(action: ActParams["action"], target: ActTarget, extra: Partial<ActParams> = {}): Promise<ActResult> {
    const r = this.#track((await this.host.call("act", { ...this.#tab(), action, ...target, ...extra, snapshot: "none" })) as ActResult);
    if (this.#tabId === undefined) {
      const active = await this.context._activeTabId();
      if (active !== undefined) this.#tabId = active;
    }
    return r;
  }
  async _cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const r = await this.host.call("cdp", { ...this.#tab(), method, params });
    return r.result;
  }

  // -- waits -----------------------------------------------------------------

  async waitForEvent(
    event: "download" | "popup" | "dialog",
    opts: { timeout?: number; accept?: boolean; promptText?: string } | number = {},
  ): Promise<Download | Page | SystemEvent> {
    const o = typeof opts === "number" ? { timeout: opts } : opts;
    const params: Record<string, unknown> = { ...this.#tab(), for: event, ...(o.timeout ? { timeoutMs: o.timeout } : {}) };
    if (event === "dialog") params.dialogAction = { accept: o.accept ?? true, ...(o.promptText !== undefined ? { promptText: o.promptText } : {}) };
    const r = collect(this.host, await this.host.call("wait", params)) as WaitResult;
    if (!r.ok) throw new ObuError("timeout", (r.warnings ?? [`no ${event}`]).join("; "), { stage: `waitForEvent(${event})` });
    if (event === "download" && r.download) return new Download(r.download, this);
    if (event === "popup" && r.tab) return new Page(this.context, r.tab.tabId);
    return r.event!;
  }
  async waitForSelector(selector: string, opts: { timeout?: number } = {}): Promise<void> {
    const r = collect(this.host, await this.host.call("wait", { ...this.#tab(), for: "selector", selector, ...(opts.timeout ? { timeoutMs: opts.timeout } : {}) })) as WaitResult;
    if (!r.ok) throw new ObuError("timeout", (r.warnings ?? []).join("; ") || `${selector} did not appear`, { stage: "waitForSelector" });
  }
  async waitForURL(url: string, opts: { timeout?: number } = {}): Promise<void> {
    const r = collect(this.host, await this.host.call("wait", { ...this.#tab(), for: "url", url, ...(opts.timeout ? { timeoutMs: opts.timeout } : {}) })) as WaitResult;
    if (!r.ok) throw new ObuError("timeout", (r.warnings ?? []).join("; ") || `URL never matched ${url}`, { stage: "waitForURL" });
    this.#url = (await this.evaluate("location.href")) as string;
  }
  async waitForText(text: string, opts: { timeout?: number } = {}): Promise<void> {
    const r = collect(this.host, await this.host.call("wait", { ...this.#tab(), for: "text", text, ...(opts.timeout ? { timeoutMs: opts.timeout } : {}) })) as WaitResult;
    if (!r.ok) throw new ObuError("timeout", (r.warnings ?? []).join("; ") || `text never appeared: ${text}`, { stage: "waitForText" });
  }
  async waitForLoadState(): Promise<void> {
    collect(this.host, await this.host.call("wait", { ...this.#tab(), for: "settled" }));
  }
  async waitForTimeout(ms: number): Promise<void> {
    this.host.warnings.push("waitForTimeout: actions already wait for the page to settle; prefer waitForSelector/waitForText");
    await new Promise((r) => setTimeout(r, Math.min(ms, 5_000)));
  }

  // -- output ----------------------------------------------------------------

  async screenshot(opts: { path?: string; fullPage?: boolean; type?: "jpeg" | "png" | "webp"; quality?: number; ref?: Ref; annotate?: boolean } = {}): Promise<Buffer> {
    const r = (await this.host.call("screenshot", {
      ...this.#tab(),
      ...(opts.fullPage ? { fullPage: true } : {}),
      ...(opts.type ? { format: opts.type } : {}),
      ...(opts.quality ? { quality: opts.quality } : {}),
      ...(opts.ref ? { ref: opts.ref } : {}),
      ...(opts.annotate ? { annotate: true } : {}),
    })) as ScreenshotResult;
    if (opts.path) copyFileSync(r.path, artifactPath(this.host, opts.path));
    return readFileSync(r.path);
  }
  /** Screenshot with numbered ref boxes, shown to the model. */
  async annotatedScreenshot(): Promise<Buffer> {
    const r = (await this.host.call("screenshot", { ...this.#tab(), annotate: true })) as ScreenshotResult;
    this.host.images.push({ path: r.path, mime: r.mime });
    return readFileSync(r.path);
  }
  async pdf(opts: { path?: string; landscape?: boolean; printBackground?: boolean } = {}): Promise<Buffer> {
    const r = (await this._cdp("Page.printToPDF", { landscape: opts.landscape ?? false, printBackground: opts.printBackground ?? true })) as { data: string };
    const buf = Buffer.from(r.data, "base64");
    writeFileSync(artifactPath(this.host, opts.path ?? `page-${Date.now()}.pdf`), buf);
    return buf;
  }

  // -- tabs ------------------------------------------------------------------

  /** Make this the session's active tab (never focuses the user's window). */
  async bringToFront(): Promise<void> {
    if (this.#tabId !== undefined) await this.host.call("tabs.select", { tabId: this.#tabId });
  }
  async close(): Promise<void> {
    if (this.#tabId === undefined) return;
    collect(this.host, await this.host.call("tabs.close", { tabId: this.#tabId }));
    this.context._forget(this);
  }
  isClosed(): boolean {
    return this.#tabId !== undefined && !this.context.pages().includes(this);
  }
}

// ---------------------------------------------------------------------------
// BrowserContext = the session's tabs.

export class BrowserContext {
  #pages: Page[] = [];
  constructor(readonly host: ReplHost) {}

  /** Open a new owned background tab (about:blank unless url given). */
  async newPage(url = "about:blank"): Promise<Page> {
    const r = collect(this.host, await this.host.call("tabs.open", { url })) as TabsOpenResult;
    return new Page(this, r.tabId);
  }
  pages(): Page[] {
    return [...this.#pages];
  }
  /** Re-sync with the daemon's view of this session's tabs. */
  async refreshPages(): Promise<Page[]> {
    const r = await this.host.call("tabs.list", { scope: "mine" });
    const known = new Map(this.#pages.filter((p) => p.tabId !== undefined).map((p) => [p.tabId!, p]));
    this.#pages = (r.tabs as { tabId: TabId }[]).map((t) => known.get(t.tabId) ?? new Page(this, t.tabId));
    return this.pages();
  }
  /** @internal */
  _adopt(page: Page): void {
    if (!this.#pages.includes(page)) this.#pages.push(page);
  }
  /** @internal */
  _forget(page: Page): void {
    this.#pages = this.#pages.filter((p) => p !== page);
  }
  /** @internal */
  async _activeTabId(): Promise<TabId | undefined> {
    const r = await this.host.call("tabs.list", { scope: "mine" });
    return r.activeTabId as TabId | undefined;
  }
}

function serializeArg(arg: unknown): string {
  return arg === undefined ? "undefined" : JSON.stringify(arg);
}

/** Normalise display() input into a file under artifacts. */
export function displayImage(host: ReplHost, input: unknown): { path: string; mime: string } {
  let buf: Buffer;
  let mime = "image/png";
  if (input && typeof input === "object" && "path" in (input as any) && typeof (input as any).path === "string") {
    const path = (input as any).path as string;
    buf = readFileSync(isAbsolute(path) ? path : artifactPath(host, path));
    mime = (input as any).mime ?? mimeFromExt(path);
  } else if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    buf = Buffer.from(input as Uint8Array);
    mime = sniffMime(buf);
  } else if (typeof input === "string") {
    const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(input);
    if (dataUrl) {
      mime = dataUrl[1]!;
      buf = Buffer.from(dataUrl[2]!, "base64");
    } else if (/^[A-Za-z0-9+/=\s]{64,}$/.test(input)) {
      buf = Buffer.from(input, "base64");
      mime = sniffMime(buf);
    } else {
      buf = readFileSync(isAbsolute(input) ? input : artifactPath(host, input));
      mime = mimeFromExt(input);
    }
  } else {
    throw new ObuError("invalid_params", "display() takes a Buffer, base64/data URL string, file path, or a screenshot result");
  }
  const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const path = artifactPath(host, `display/${Date.now()}-${host.images.length}.${ext}`);
  writeFileSync(path, buf);
  return { path, mime };
}

function sniffMime(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(0, 3).toString() === "GIF") return "image/gif";
  return "image/png";
}
function mimeFromExt(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/png";
}

