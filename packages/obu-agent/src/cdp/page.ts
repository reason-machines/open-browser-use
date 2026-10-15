// WS-C: per-tab CDP runtime. Builds the PageContext (seams.ts) that the
// snapshot (WS-D) and action (WS-E) modules consume.
//
//  - A3 attach sequence minus Runtime.enable (I8)
//  - owned tabs: 1440x900 metrics override + lifecycle 'active' (I6)
//  - OOPIFs via Target.setAutoAttach{flatten} child sessions
//  - injected bundle in isolated world UTILITY_WORLD_NAME, health-checked and
//    re-injected after navigation (10 tries x 200 ms)
//  - focus emulation only for the duration of act/navigate/snapshot (I7)
//  - dialog policy (never leave a tab hung on a dialog)
import { AGENT_VIEWPORT, UTILITY_WORLD_NAME, type Ownership, type SystemEvent, type TabId } from "../contract.js";
import { ObuError } from "../errors.js";
import type { FrameHandle, PageContext, TabCdp } from "../seams.js";
import { isContextGoneError, type BackendOwner, type BrowserBackend } from "./backend.js";

type EventInput = SystemEvent extends infer E ? (E extends SystemEvent ? Omit<E, "seq" | "at" | "sessionId"> : never) : never;

export interface DialogDecision {
  accept: boolean;
  promptText?: string;
}

interface ChildTarget {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  /** Child setup finished (Page.enable etc.). */
  ready: Promise<void>;
}

interface FrameState {
  frameId: string;
  /** undefined = main session. */
  sessionId?: string;
  parentId?: string;
  ordinal: number;
  url: string;
  contextId?: number;
}

export interface TabRuntimeOptions {
  backend: BrowserBackend;
  tabId: TabId;
  targetId?: string;
  /** Current backend owner (root session key); looked up per call because tabs move between sessions. */
  owner: () => BackendOwner;
  ownership: () => Ownership;
  bundleSource: () => string;
  bundleVersion: () => string;
  /** Deliver a SystemEvent to whichever session owns the tab now. */
  emit: (event: EventInput) => void;
  /** Pending `wait{for:'dialog'}` decision, consumed by the next dialog. */
  takeDialogDecision: () => DialogDecision | undefined;
}

const CHILD_TARGET_TYPES = new Set(["iframe"]);

export class TabRuntime {
  readonly tabId: TabId;
  targetId: string;
  readonly cdp: TabCdp;
  #opts: TabRuntimeOptions;
  #setup: Promise<string[]> | null = null;
  #setupRunning = false;
  #children = new Map<string, ChildTarget>(); // sessionId -> child
  #frames = new Map<string, FrameState>(); // frameId -> state
  #nextOrdinal = 1;
  #mainFrameId: string | undefined;
  /** Frame tree must be re-read (main-frame document changed / bfcache restore). */
  #framesDirty = false;
  #unsubscribe: () => void;
  #inCall = 0;
  #disposed = false;
  #handlers = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  /** Warnings collected during setup, surfaced once in the next result. */
  setupWarnings: string[] = [];

  constructor(opts: TabRuntimeOptions) {
    this.#opts = opts;
    this.tabId = opts.tabId;
    this.targetId = opts.targetId ?? "";
    const runtime = this;
    this.cdp = {
      tabId: opts.tabId,
      get targetId() {
        return runtime.targetId;
      },
      send: (method, params, sendOpts) => this.send(method, params, sendOpts),
      on: (event, handler) => this.on(event, handler),
    } as TabCdp;
    this.#unsubscribe = opts.backend.onEvent((event) => {
      if ((event.type === "attached" || event.type === "detached") && event.tabId === this.tabId) {
        // A fresh attachment while our own setup is running is the attach that
        // setup itself triggered: the setup configures it. Anything else (idle
        // detach, infobar Cancel, re-attach by another call) wipes CDP state.
        if (event.type === "attached" && this.#setupRunning) return;
        this.#resetSetup();
        return;
      }
      if (event.type !== "cdp" || event.tabId !== this.tabId) return;
      this.#onCdpEvent(event.method, event.params, event.sessionId);
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe();
    this.#handlers.clear();
  }

  get inCall(): boolean {
    return this.#inCall > 0;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, opts: { sessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    if (method === "Runtime.enable" || method === "Debugger.enable") {
      return Promise.reject(new ObuError("cdp_denied", `${method} is never sent to agent pages (I8)`));
    }
    return this.#opts.backend.send<T>(this.#opts.owner(), this.tabId, method, params, opts);
  }

  on(event: string, handler: (params: any, sessionId?: string) => void): () => void {
    let set = this.#handlers.get(event);
    if (!set) this.#handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Attach sequence

  /** Idempotent per attach generation. Returns setup warnings (non-fatal steps that failed). */
  ensureSetup(): Promise<string[]> {
    if (!this.#setup) {
      this.#setupRunning = true;
      const setup = this.#runSetup()
        .catch((error) => {
          if (this.#setup === setup) this.#setup = null;
          throw error;
        })
        .finally(() => {
          this.#setupRunning = false;
        });
      this.#setup = setup;
    }
    return this.#setup;
  }

  #resetSetup(): void {
    this.#setup = null;
    this.#children.clear();
    for (const frame of this.#frames.values()) frame.contextId = undefined;
  }

  async #runSetup(): Promise<string[]> {
    const owned = this.#opts.ownership() === "owned";
    const warnings: string[] = [];
    const soft = async (method: string, params: Record<string, unknown> = {}) => {
      try {
        await this.send(method, params, { timeoutMs: 5_000 });
      } catch (error) {
        warnings.push(`${method} failed: ${(error as Error).message}`);
      }
    };
    await this.#opts.backend.attach(this.#opts.owner(), this.tabId);
    await this.send("Page.enable", {}, { timeoutMs: 10_000 });
    await soft("DOM.enable");
    await soft("Network.enable");
    await soft("Inspector.enable");
    if (owned) {
      await soft("Page.setWebLifecycleState", { state: "active" });
      await soft("Emulation.setDeviceMetricsOverride", {
        width: AGENT_VIEWPORT.width,
        height: AGENT_VIEWPORT.height,
        deviceScaleFactor: 0,
        mobile: false,
      });
    }
    await soft("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const source = this.#opts.bundleSource();
    if (source) await soft("Page.addScriptToEvaluateOnNewDocument", { source, worldName: UTILITY_WORLD_NAME, runImmediately: true });
    await this.#refreshFrameTree();
    this.setupWarnings.push(...warnings);
    return warnings;
  }

  async #setupChild(child: ChildTarget): Promise<void> {
    const opts = { sessionId: child.sessionId, timeoutMs: 5_000 };
    const soft = (method: string, params: Record<string, unknown> = {}) => this.send(method, params, opts).catch(() => undefined);
    await soft("Page.enable");
    await soft("Network.enable");
    await soft("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const source = this.#opts.bundleSource();
    if (source) await soft("Page.addScriptToEvaluateOnNewDocument", { source, worldName: UTILITY_WORLD_NAME, runImmediately: true });
    await soft("Runtime.runIfWaitingForDebugger");
    await this.#refreshFrameTree(child.sessionId);
  }

  async #refreshFrameTree(sessionId?: string): Promise<void> {
    const { frameTree } = await this.send<any>("Page.getFrameTree", {}, { sessionId, timeoutMs: 5_000 });
    const seen = new Set<string>();
    const walk = (node: any, parentId?: string) => {
      const frame = node.frame;
      seen.add(frame.id);
      this.#trackFrame(frame.id, sessionId, parentId ?? frame.parentId, frame.url ?? "");
      for (const child of node.childFrames ?? []) walk(child, frame.id);
    };
    walk(frameTree);
    if (!sessionId) this.#mainFrameId = frameTree.frame.id;
    // Drop frames of this session that disappeared.
    for (const [frameId, state] of this.#frames) {
      if (state.sessionId === sessionId && !seen.has(frameId)) this.#frames.delete(frameId);
    }
  }

  #trackFrame(frameId: string, sessionId: string | undefined, parentId: string | undefined, url: string): FrameState {
    let state = this.#frames.get(frameId);
    if (!state) {
      const isMain = !sessionId && !parentId;
      state = { frameId, sessionId, parentId, url, ordinal: isMain ? 0 : this.#nextOrdinal++ };
      this.#frames.set(frameId, state);
    } else {
      // An OOPIF swap moves a frame to a child session; keep its ordinal (stable refs).
      if (state.sessionId !== sessionId) state.contextId = undefined;
      state.sessionId = sessionId;
      state.parentId = parentId ?? state.parentId;
      state.url = url || state.url;
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // CDP events

  #onCdpEvent(method: string, params: any, sessionId?: string): void {
    switch (method) {
      case "Target.attachedToTarget": {
        const info = params.targetInfo ?? {};
        if (!CHILD_TARGET_TYPES.has(info.type)) {
          // Workers etc.: let them run, we never instrument them.
          void this.send("Runtime.runIfWaitingForDebugger", {}, { sessionId: params.sessionId }).catch(() => undefined);
          break;
        }
        const child: ChildTarget = { sessionId: params.sessionId, targetId: info.targetId, type: info.type, url: info.url ?? "", ready: Promise.resolve() };
        child.ready = this.#setupChild(child).catch(() => undefined);
        this.#children.set(child.sessionId, child);
        break;
      }
      case "Target.detachedFromTarget": {
        const child = this.#children.get(params.sessionId);
        this.#children.delete(params.sessionId);
        if (child) for (const [frameId, state] of this.#frames) if (state.sessionId === child.sessionId) this.#frames.delete(frameId);
        break;
      }
      case "Page.frameNavigated": {
        const frame = params.frame;
        const state = this.#trackFrame(frame.id, sessionId, frame.parentId, frame.url ?? "");
        state.contextId = undefined;
        if (!sessionId && !frame.parentId) {
          this.#mainFrameId = frame.id;
          // New main document: iframe ordinals restart (refs are per document, like the snapshot's).
          for (const [frameId, other] of this.#frames) {
            if (frameId !== frame.id) this.#frames.delete(frameId);
          }
          this.#nextOrdinal = 1;
          this.#framesDirty = true;
          if (!this.inCall) this.#opts.emit({ type: "navigation", tabId: this.tabId, url: frame.url, kind: "nav" });
        }
        break;
      }
      case "Page.navigatedWithinDocument": {
        if (!sessionId && params.frameId === this.#mainFrameId && !this.inCall) {
          this.#opts.emit({ type: "navigation", tabId: this.tabId, url: params.url, kind: "spa" });
        }
        break;
      }
      case "Page.frameAttached":
        this.#trackFrame(params.frameId, sessionId, params.parentFrameId, "");
        break;
      case "Page.frameDetached":
        if (params.reason !== "swap") this.#frames.delete(params.frameId);
        break;
      case "Page.javascriptDialogOpening":
        void this.#handleDialog(params, sessionId);
        break;
    }
    const handlers = this.#handlers.get(method);
    if (handlers) for (const handler of handlers) {
      try {
        handler(params, sessionId);
      } catch {
        // subscriber bug must not break the pump
      }
    }
  }

  async #handleDialog(params: any, sessionId?: string): Promise<void> {
    const type = params.type as "alert" | "confirm" | "prompt" | "beforeunload";
    const decision = this.#opts.takeDialogDecision() ?? { accept: type !== "prompt" };
    try {
      await this.send(
        "Page.handleJavaScriptDialog",
        { accept: decision.accept, ...(decision.promptText !== undefined ? { promptText: decision.promptText } : {}) },
        { sessionId, timeoutMs: 5_000 },
      );
    } catch {
      // Already handled (e.g. by the user) — still report it.
    }
    this.#opts.emit({ type: "dialog", tabId: this.tabId, dialogType: type, message: String(params.message ?? ""), action: decision.accept ? "accepted" : "dismissed" });
  }

  // -------------------------------------------------------------------------
  // Frames, isolated worlds, injected calls

  async frames(): Promise<FrameHandle[]> {
    await this.ensureSetup();
    await Promise.all([...this.#children.values()].map((child) => child.ready));
    if (!this.#mainFrameId || this.#framesDirty) await this.#refreshAllFrames();
    const states = [...this.#frames.values()].sort((a, b) => a.ordinal - b.ordinal);
    const handles: FrameHandle[] = [];
    for (const state of states) {
      try {
        handles.push(await this.#handleFor(state));
      } catch (error) {
        if (state.ordinal === 0) throw error;
        // A child frame mid-navigation / detached: skip it this call.
      }
    }
    return handles;
  }

  async #refreshAllFrames(): Promise<void> {
    this.#framesDirty = false;
    await this.#refreshFrameTree();
    await Promise.all([...this.#children.keys()].map((sessionId) => this.#refreshFrameTree(sessionId).catch(() => undefined)));
  }

  async mainFrame(): Promise<FrameHandle> {
    await this.ensureSetup();
    if (!this.#mainFrameId) await this.#refreshFrameTree();
    const state = this.#frames.get(this.#mainFrameId!);
    if (!state) throw new ObuError("internal", "main frame is not known yet");
    return this.#handleFor(state);
  }

  async #handleFor(state: FrameState): Promise<FrameHandle> {
    const contextId = await this.#ensureWorld(state);
    let origin = "";
    try {
      origin = new URL(state.url).origin;
    } catch {
      origin = "";
    }
    return { ordinal: state.ordinal, frameId: state.frameId, sessionId: state.sessionId, utilityContextId: contextId, origin };
  }

  /** Create (or find) the utility world of a frame and make sure `__obu` is installed. */
  async #ensureWorld(state: FrameState): Promise<number> {
    if (state.contextId !== undefined) return state.contextId;
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const { executionContextId } = await this.send<any>(
          "Page.createIsolatedWorld",
          { frameId: state.frameId, worldName: UTILITY_WORLD_NAME, grantUniveralAccess: true },
          { sessionId: state.sessionId, timeoutMs: 5_000 },
        );
        await this.#installBundle(state, executionContextId);
        state.contextId = executionContextId;
        return executionContextId;
      } catch (error) {
        lastError = error;
        if (!isContextGoneError(error) && !/No frame|frame.*not found|Frame with the given id/i.test(String((error as Error).message))) break;
        await sleep(200);
      }
    }
    throw lastError instanceof ObuError ? lastError : new ObuError("internal", `cannot create the utility world for frame ${state.frameId}: ${(lastError as Error)?.message ?? lastError}`);
  }

  async #installBundle(state: FrameState, contextId: number): Promise<void> {
    const source = this.#opts.bundleSource();
    if (!source) return;
    const check = async () => {
      const result = await this.send<any>(
        "Runtime.evaluate",
        { expression: "globalThis.__obu && globalThis.__obu.version", contextId, returnByValue: true },
        { sessionId: state.sessionId, timeoutMs: 5_000 },
      );
      return result?.result?.value as string | undefined;
    };
    const version = await check();
    if (version && version === this.#opts.bundleVersion()) return;
    const installed = await this.send<any>("Runtime.evaluate", { expression: source, contextId, returnByValue: true }, { sessionId: state.sessionId, timeoutMs: 10_000 });
    if (installed?.exceptionDetails) {
      throw new ObuError("internal", `injected bundle failed in frame ${state.frameId}: ${describeException(installed.exceptionDetails)}`);
    }
  }

  async callInjected<T>(frame: FrameHandle, method: string, args: unknown[]): Promise<T> {
    const run = (contextId: number) =>
      this.send<any>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function(m, a) { const api = globalThis.__obu; if (!api) throw new Error('__obu is not installed'); return api[m](...a); }",
          executionContextId: contextId,
          arguments: [{ value: method }, { value: args }],
          returnByValue: true,
          awaitPromise: true,
        },
        { sessionId: frame.sessionId, timeoutMs: 30_000 },
      );
    let response: any;
    try {
      response = await run(frame.utilityContextId);
    } catch (error) {
      if (!isContextGoneError(error)) throw error;
      const contextId = await this.#reworld(frame);
      response = await run(contextId);
    }
    if (response?.exceptionDetails) {
      const description = describeException(response.exceptionDetails);
      if (/__obu is not installed/.test(description)) {
        const contextId = await this.#reworld(frame);
        response = await run(contextId);
        if (!response?.exceptionDetails) return response?.result?.value as T;
      }
      throw new ObuError("internal", `__obu.${method} threw: ${describeException(response.exceptionDetails)}`);
    }
    return response?.result?.value as T;
  }

  async #reworld(frame: FrameHandle): Promise<number> {
    const state = this.#frames.get(frame.frameId);
    if (!state) throw new ObuError("stale_ref", `frame ${frame.frameId} is gone (navigated or detached); take a new snapshot`);
    state.contextId = undefined;
    const contextId = await this.#ensureWorld(state);
    frame.utilityContextId = contextId;
    return contextId;
  }

  async resolveRef(ref: string): Promise<{ frame: FrameHandle; objectId: string } | null> {
    const match = /^(?:f(\d+))?e\d+$/.exec(ref);
    if (!match) throw new ObuError("invalid_params", `"${ref}" is not a snapshot ref (expected eN or fKeN)`, { ref });
    const ordinal = match[1] ? Number(match[1]) : 0;
    const frames = await this.frames();
    const frame = frames.find((candidate) => candidate.ordinal === ordinal);
    if (!frame) return null;
    const call = (contextId: number) =>
      this.send<any>(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: "function(r) { return globalThis.__obu ? globalThis.__obu.deref(r) : null; }",
          executionContextId: contextId,
          arguments: [{ value: ref }],
          returnByValue: false,
        },
        { sessionId: frame.sessionId, timeoutMs: 10_000 },
      );
    let response: any;
    try {
      response = await call(frame.utilityContextId);
    } catch (error) {
      if (!isContextGoneError(error)) throw error;
      response = await call(await this.#reworld(frame));
    }
    const objectId = response?.result?.objectId;
    if (!objectId || response?.result?.subtype === "null") return null;
    return { frame, objectId };
  }

  /** Evaluate an expression in the main frame (isolated world by default; never Runtime.enable). */
  async evaluate(expression: string, world: "isolated" | "page", awaitPromise: boolean): Promise<unknown> {
    const params: Record<string, unknown> = { expression, returnByValue: true, awaitPromise };
    if (world === "isolated") {
      const frame = await this.mainFrame();
      params.contextId = frame.utilityContextId;
    } else {
      await this.ensureSetup();
    }
    let response: any;
    try {
      response = await this.send<any>("Runtime.evaluate", params, { timeoutMs: 30_000 });
    } catch (error) {
      if (world !== "isolated" || !isContextGoneError(error)) throw error;
      const frame = await this.mainFrame();
      params.contextId = await this.#reworld(frame);
      response = await this.send<any>("Runtime.evaluate", params, { timeoutMs: 30_000 });
    }
    if (response?.exceptionDetails) throw new ObuError("internal", `evaluate threw: ${describeException(response.exceptionDetails)}`);
    return response?.result?.value;
  }

  /** Child session for a frame ref prefix ('f2' / 'f2e5'), for the `cdp` escape hatch. */
  async sessionForFrameRef(frameRef: string): Promise<string | undefined> {
    const match = /^f(\d+)/.exec(frameRef);
    if (!match) throw new ObuError("invalid_params", `frameRef "${frameRef}" must look like fK`);
    const frames = await this.frames();
    const frame = frames.find((candidate) => candidate.ordinal === Number(match[1]));
    if (!frame) throw new ObuError("stale_ref", `frame ${frameRef} no longer exists; take a new snapshot`);
    return frame.sessionId;
  }

  // -------------------------------------------------------------------------
  // Page calls

  /**
   * Run one page operation (the caller holds the tab mutex). `focus`: enable
   * focus emulation for its duration (I7: act / navigate / snapshot only).
   */
  async run<T>(focus: boolean, fn: () => Promise<T>): Promise<T> {
    await this.ensureSetup();
    this.#inCall++;
    // Focus emulation on the tab AND every OOPIF child session: focusing an
    // element inside a cross-process frame without it makes Chrome move real
    // (OS-level) focus to the frame, which brings Chrome to the front.
    const focusedSessions: (string | undefined)[] = [];
    try {
      if (focus) {
        const sessions = [undefined, ...[...this.#children.keys()]];
        await Promise.all(
          sessions.map((sessionId) =>
            this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, { sessionId, timeoutMs: 3_000 }).then(
              () => void focusedSessions.push(sessionId),
              () => undefined,
            ),
          ),
        );
      }
      return await fn();
    } finally {
      await Promise.all(
        focusedSessions.map((sessionId) => this.send("Emulation.setFocusEmulationEnabled", { enabled: false }, { sessionId, timeoutMs: 3_000 }).catch(() => undefined)),
      );
      this.#inCall--;
    }
  }

  /** Build the PageContext for one call. */
  context(sessionId: string, artifactDir: string, previousTree: string | undefined, emit: (event: EventInput) => void): PageContext {
    return {
      sessionId,
      cdp: this.cdp,
      frames: () => this.frames(),
      callInjected: (frame, method, args) => this.callInjected(frame, method, args),
      resolveRef: (ref) => this.resolveRef(ref),
      emit: (event) => emit(event as EventInput),
      artifactDir,
      previousTree,
    };
  }

  get disposed(): boolean {
    return this.#disposed;
  }
}

function describeException(details: any): string {
  return String(details?.exception?.description ?? details?.exception?.value ?? details?.text ?? "unknown error").split("\n")[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
