// r2-repl: Aside-style "code mode". One persistent JS sandbox per agent
// session; bindings survive across `repl.run` calls; console output is the
// result. Browser access goes through the same daemon handlers as the fat tools.
//
// Not a security boundary (node:vm shares the process); it is a capability
// boundary: no require/process/child_process/network, fs only under ./artifacts.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { inspect } from "node:util";
import vm from "node:vm";
import type { ReplRunResult, SystemEvent } from "../contract.js";
import { ObuError } from "../errors.js";
import { BrowserContext, Page, artifactPath, displayImage, type ReplCall, type ReplHost } from "./api.js";
import { ReplSyntaxError, transformCell } from "./transform.js";

export { transformCell } from "./transform.js";
export { BrowserContext, Download, Locator, Page, Snapshot } from "./api.js";

export const REPL_DEFAULT_TIMEOUT_MS = 30_000;
export const REPL_MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 60_000;

interface ReplState {
  context: vm.Context;
  host: ReplHost;
  output: string[];
  outputChars: number;
  busy: boolean;
}

export interface ReplManagerOptions {
  /** Bound daemon call for a session (sessionId injected by the caller). */
  callFor(sessionId: string): ReplCall;
  artifactsDirFor(sessionId: string): string;
}

export class ReplManager {
  #states = new Map<string, ReplState>();
  constructor(private readonly opts: ReplManagerOptions) {}

  has(sessionId: string): boolean {
    return this.#states.has(sessionId);
  }
  sessions(): string[] {
    return [...this.#states.keys()];
  }
  reset(sessionId: string): void {
    this.#states.delete(sessionId);
  }

  async run(sessionId: string, code: string, timeoutMs = REPL_DEFAULT_TIMEOUT_MS): Promise<Omit<ReplRunResult, "events"> & { events: SystemEvent[] }> {
    if (typeof code !== "string") throw new ObuError("invalid_params", "repl.run requires code (a string of JavaScript)");
    const timeout = Math.max(100, Math.min(timeoutMs, REPL_MAX_TIMEOUT_MS));
    const state = this.#state(sessionId);
    if (state.busy) throw new ObuError("lease_conflict", "the previous repl.run of this session is still running; wait for it (or repl.reset)");
    state.busy = true;
    state.output = [];
    state.outputChars = 0;
    state.host.events = [];
    state.host.images = [];
    state.host.warnings = [];
    const started = Date.now();
    let value: string | undefined;
    let error: ReplRunResult["error"];
    let timer: NodeJS.Timeout | undefined;
    try {
      const body = transformCell(code);
      const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "repl-cell.js" });
      const promise = script.runInContext(state.context, { timeout, breakOnSigint: false }) as Promise<unknown>;
      const result = await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new ObuError("timeout", `repl.run exceeded ${timeout} ms (the cell may still be running in the background; its later output is dropped)`, { stage: "repl" })), timeout);
        }),
      ]);
      if (result !== undefined) value = formatValue(result);
    } catch (thrown) {
      error = describeError(thrown);
    } finally {
      if (timer) clearTimeout(timer);
      state.busy = false;
    }
    const output = state.output.join("\n");
    return {
      ok: !error,
      output: state.outputChars > MAX_OUTPUT_CHARS ? `${output}\n… output truncated at ${MAX_OUTPUT_CHARS} chars; log less (e.g. snapshot({interactive:true}) or scope by ref)` : output,
      ...(value !== undefined ? { value } : {}),
      ...(error ? { error } : {}),
      images: [...state.host.images],
      ...(state.host.warnings.length ? { warnings: [...new Set(state.host.warnings)] } : {}),
      artifactsDir: state.host.artifactsDir,
      ms: Date.now() - started,
      events: [...state.host.events],
    };
  }

  #state(sessionId: string): ReplState {
    const existing = this.#states.get(sessionId);
    if (existing) return existing;
    const artifactsDir = this.opts.artifactsDirFor(sessionId);
    mkdirSync(artifactsDir, { recursive: true });
    const host: ReplHost = { call: this.opts.callFor(sessionId), artifactsDir, events: [], images: [], warnings: [] };
    const state: ReplState = { context: vm.createContext({}), host, output: [], outputChars: 0, busy: false };
    const write = (level: string, args: unknown[]) => {
      if (state.outputChars > MAX_OUTPUT_CHARS) return;
      const line = (level === "log" || level === "info" ? "" : `[${level}] `) + args.map((a) => (typeof a === "string" ? a : formatValue(a))).join(" ");
      state.outputChars += line.length + 1;
      state.output.push(line);
    };
    const browserContext = new BrowserContext(host);
    const page = new Page(browserContext);
    const globals: Record<string, unknown> = {
      console: {
        log: (...a: unknown[]) => write("log", a),
        info: (...a: unknown[]) => write("info", a),
        warn: (...a: unknown[]) => write("warn", a),
        error: (...a: unknown[]) => write("error", a),
        debug: (...a: unknown[]) => write("debug", a),
        dir: (o: unknown) => write("log", [o]),
        table: (o: unknown) => write("log", [o]),
      },
      page,
      context: browserContext,
      /** Aria snapshot of `page` (or the given page). */
      snapshot: (target?: Page | { interactive?: boolean; ref?: string; selector?: string; maxChars?: number }, opts?: { interactive?: boolean; ref?: string; selector?: string; maxChars?: number }) =>
        target instanceof Page ? target.snapshot(opts) : page.snapshot(target ?? {}),
      display: (img: unknown) => {
        const shown = displayImage(host, img);
        host.images.push(shown);
        return shown.path;
      },
      sleep: async (ms: number) => {
        host.warnings.push("sleep(): actions already wait for the page to settle; use page.waitForText/waitForSelector instead");
        await new Promise((r) => setTimeout(r, Math.min(Math.max(0, Number(ms) || 0), 5_000)));
      },
      fs: {
        readFile: (path: string, encoding: BufferEncoding | null = "utf8") => (encoding ? readFileSync(artifactPath(host, path), encoding) : readFileSync(artifactPath(host, path))),
        writeFile: (path: string, data: string | Uint8Array) => {
          const full = artifactPath(host, path);
          writeFileSync(full, data);
          return full;
        },
        exists: (path: string) => existsSync(artifactPath(host, path)),
        list: (path = ".") => readdirSync(artifactPath(host, path)).map((name) => ({ name, bytes: statSync(artifactPath(host, `${path}/${name}`)).size })),
      },
      artifactsDir: artifactsDir,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      structuredClone,
      atob,
      btoa,
    };
    for (const [name, value] of Object.entries(globals)) {
      Object.defineProperty(state.context, name, { value, writable: true, configurable: true, enumerable: false });
    }
    this.#states.set(sessionId, state);
    return state;
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return inspect(value, { depth: 4, maxArrayLength: 200, maxStringLength: 20_000, breakLength: 120 });
}

function describeError(thrown: unknown): NonNullable<ReplRunResult["error"]> {
  if (thrown instanceof ObuError) return { name: "ObuError", code: thrown.code, message: thrown.message };
  if (thrown instanceof ReplSyntaxError) return { name: "SyntaxError", message: thrown.message };
  if (thrown && typeof thrown === "object" && "message" in thrown) {
    const e = thrown as { name?: string; message: string; stack?: string; code?: string };
    // Errors from inside the context are not `instanceof` host classes.
    const code = typeof e.code === "string" ? e.code : undefined;
    const stack = e.stack?.split("\n").filter((l) => l.includes("repl-cell.js")).slice(0, 3).join("\n");
    return { name: e.name ?? "Error", message: e.message, ...(code ? { code } : {}), ...(stack ? { stack } : {}) };
  }
  return { name: "Error", message: String(thrown) };
}
