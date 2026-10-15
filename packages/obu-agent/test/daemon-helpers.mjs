// Shared helpers for WS-C daemon tests: an in-memory BrowserBackend and a fake clock.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, openStore } from "../dist/index.js";

export class FakeClock {
  constructor(t = 1_000_000) { this.t = t; }
  now() { return this.t; }
  advance(ms) { this.t += ms; }
}

export class FakeBackend {
  kind = "direct";
  tabs = new Map(); // tabId -> {tabId, url, title, active, owner}
  log = []; // [tabId, method, params, sessionId]
  closed = [];
  released = [];
  finalized = [];
  #handlers = new Set();
  #next = 100;
  #ctx = 1;
  connectedFlag = true;
  async connect() { this.connectedFlag = true; }
  isConnected() { return this.connectedFlag; }
  version() { return "fake/1"; }
  caps = { tabEvents: true, downloads: false, closeTab: true };
  capabilities() { return this.caps; }
  async createTab(owner, url) {
    const tab = { tabId: this.#next++, url, title: "", owner: owner.key, active: false };
    this.tabs.set(tab.tabId, tab);
    return { tabId: tab.tabId, targetId: `T${tab.tabId}`, url, title: "" };
  }
  addUserTab(url, extra = {}) {
    const tab = { tabId: this.#next++, url, title: "user", owner: null, active: false, ...extra };
    this.tabs.set(tab.tabId, tab);
    return tab.tabId;
  }
  async closeTab(_owner, tabId) { this.closed.push(tabId); this.tabs.delete(tabId); }
  async claimTab(owner, tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with given id ${tabId}`);
    tab.owner = owner.key;
    return { tabId, url: tab.url, title: tab.title };
  }
  async releaseTab(_owner, tabId) { this.released.push(tabId); }
  async finalize(owner, keep) { this.finalized.push({ owner: owner.key, keep }); }
  async getTab(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? { tabId, url: tab.url, title: tab.title, active: tab.active } : undefined;
  }
  async listBrowserTabs() { return [...this.tabs.values()].map((t) => ({ tabId: t.tabId, url: t.url, title: t.title })); }
  async attach() {}
  async send(_owner, tabId, method, params = {}, opts = {}) {
    this.log.push([tabId, method, params, opts.sessionId]);
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`No tab with given id ${tabId}`);
    switch (method) {
      case "Page.getFrameTree": return { frameTree: { frame: { id: `F${tabId}`, url: tab.url } } };
      case "Page.createIsolatedWorld": return { executionContextId: this.#ctx++ };
      case "Page.navigate":
        tab.url = params.url; tab.title = `title of ${params.url}`;
        queueMicrotask(() => this.emit({ type: "cdp", tabId, method: "Page.loadEventFired", params: {} }));
        return { frameId: `F${tabId}`, loaderId: "L1" };
      case "Target.getTargetInfo": return { targetInfo: { targetId: `T${tabId}` } };
      case "Runtime.evaluate": {
        if (params.expression === "[location.href, document.title]") return { result: { value: [tab.url, tab.title] } };
        if (/^__sleep\((\d+)\)$/.test(params.expression)) {
          await new Promise((r) => setTimeout(r, Number(/\d+/.exec(params.expression)[0])));
          return { result: { value: "slept" } };
        }
        return { result: { value: tab.evalValue ?? null } };
      }
      default: return {};
    }
  }
  methods(tabId) { return this.log.filter((e) => tabId === undefined || e[0] === tabId).map((e) => e[1]); }
  onEvent(handler) { this.#handlers.add(handler); return () => this.#handlers.delete(handler); }
  emit(event) { for (const h of this.#handlers) h(event); }
  async close() {}
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function makeDaemon({ backend = new FakeBackend(), clock = new FakeClock(), storePath = ":memory:", modules = {}, leaseTtlMs } = {}) {
  const artifactRoot = mkdtempSync(join(tmpdir(), "obu-wsc-art-"));
  const daemon = new Daemon({
    profile: "Default",
    backend,
    store: openStore(storePath),
    artifactRoot,
    clock,
    leaseTtlMs,
    sweepMs: 60_000, // tests sweep explicitly
    bundle: { source: "", version: "test" },
    modules: {
      takeSnapshot: async (page, params) => ({ tree: `- tree ${params.tabId}`, diff: page.previousTree ? "~" : "", url: "u", title: "t", tabId: params.tabId, refCount: 0, warnings: [] }),
      act: async () => ({ ok: true, settled: { kind: "dom", ms: 1 } }),
      performActionAndWait: async (_page, action) => { await action(); return { kind: "nav", ms: 1 }; },
      screenshot: async () => ({ path: "/tmp/x.jpg", mime: "image/jpeg", width: 1, height: 1, via: "capture" }),
      ...modules,
    },
  });
  await daemon.start();
  const h = daemon.handlers();
  const call = async (method, params) => h[method](params, { connectionId: 1 });
  return { daemon, backend, clock, call };
}
