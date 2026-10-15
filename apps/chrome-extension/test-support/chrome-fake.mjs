// In-memory chrome.* fake for agent-wire tests. Models the parts of tabs,
// tabGroups, windows, debugger, downloads, storage, alarms and native
// messaging that background.js touches, including the events Chrome fires.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BACKGROUND_PATH = path.join(HERE, "..", "background.js");

function event() {
  const listeners = new Set();
  return {
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    fire(...args) {
      for (const fn of [...listeners]) fn(...args);
    },
    get size() {
      return listeners.size;
    }
  };
}

export function createChromeFake({ windows = [{ id: 1, focused: true, type: "normal" }] } = {}) {
  const state = {
    nextTabId: 100,
    nextGroupId: 10,
    tabs: new Map(),
    groups: new Map(),
    windows: new Map(windows.map((win) => [win.id, { ...win }])),
    lastFocusedWindowId: windows.find((win) => win.focused)?.id ?? windows[0]?.id ?? null,
    attached: new Set(),
    attachCalls: [],
    commands: [],
    targets: new Map(),
    storage: {},
    posted: [],
    created: []
  };
  const port = {
    onMessage: event(),
    onDisconnect: event(),
    postMessage(message) {
      // Native messaging serialises JSON; this also strips VM-realm prototypes.
      state.posted.push(JSON.parse(JSON.stringify(message)));
    },
    disconnect() {}
  };

  function tabCopy(tab) {
    return { ...tab };
  }

  function disposeEmptyGroups() {
    for (const groupId of [...state.groups.keys()]) {
      if (![...state.tabs.values()].some((tab) => tab.groupId === groupId)) state.groups.delete(groupId);
    }
  }

  function setGroup(tab, groupId) {
    if (tab.groupId === groupId) return;
    tab.groupId = groupId;
    chrome.tabs.onUpdated.fire(tab.id, { groupId }, tabCopy(tab));
  }

  const chrome = {
    runtime: {
      id: "fake-extension",
      lastError: undefined,
      getManifest: () => ({ version: "9.9.9" }),
      connectNative: () => port,
      onInstalled: event(),
      onMessage: event()
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return key in state.storage ? { [key]: state.storage[key] } : {};
          return { ...state.storage };
        },
        async set(values) {
          Object.assign(state.storage, structuredClone(values));
        }
      },
      onChanged: event()
    },
    alarms: { create: async () => {}, onAlarm: event() },
    scripting: {
      executeScript: async () => [],
      getRegisteredContentScripts: async () => [],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {}
    },
    history: { search: async () => [] },
    windows: {
      async get(windowId) {
        const win = state.windows.get(windowId);
        if (!win) throw new Error(`No window with id: ${windowId}.`);
        return { ...win };
      },
      async getAll() {
        return [...state.windows.values()].map((win) => ({ ...win }));
      },
      async getLastFocused() {
        const win = state.windows.get(state.lastFocusedWindowId);
        if (!win) throw new Error("No last-focused window");
        return { ...win };
      },
      async create({ url, focused }) {
        const id = Math.max(0, ...state.windows.keys()) + 1;
        state.windows.set(id, { id, focused: Boolean(focused), type: "normal" });
        const tab = await chrome.tabs.create({ url, windowId: id, active: true });
        return { id, tabs: [tab] };
      }
    },
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onMoved: event(),
      async create({ url = "about:blank", windowId, active = true, openerTabId, groupId = -1 }) {
        const id = state.nextTabId++;
        const tab = {
          id,
          windowId,
          url,
          title: "",
          active: Boolean(active),
          groupId,
          index: state.tabs.size,
          ...(Number.isInteger(openerTabId) ? { openerTabId } : {})
        };
        if (active) for (const other of state.tabs.values()) if (other.windowId === windowId) other.active = false;
        state.tabs.set(id, tab);
        state.targets.set(id, `target-${id}`);
        state.created.push({ id, windowId, active: Boolean(active), url });
        chrome.tabs.onCreated.fire(tabCopy(tab));
        if (active) chrome.tabs.onActivated.fire({ tabId: id, windowId });
        return tabCopy(tab);
      },
      async get(tabId) {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        return tabCopy(tab);
      },
      async query(filter = {}) {
        return [...state.tabs.values()]
          .filter((tab) => typeof filter.groupId !== "number" || tab.groupId === filter.groupId)
          .map(tabCopy);
      },
      async remove(tabIds) {
        for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          if (!state.tabs.has(id)) continue;
          state.tabs.delete(id);
          state.attached.delete(id);
          chrome.tabs.onRemoved.fire(id, { windowId: 1, isWindowClosing: false });
        }
        disposeEmptyGroups();
      },
      async group({ groupId, tabIds }) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        let target = groupId;
        if (typeof target !== "number") {
          const first = state.tabs.get(ids[0]);
          if (!first) throw new Error(`No tab with id: ${ids[0]}.`);
          if (state.windows.get(first.windowId)?.type === "popup") {
            throw new Error("Tabs can only be moved to and from normal windows.");
          }
          target = state.nextGroupId++;
          state.groups.set(target, { id: target, windowId: first.windowId, title: "", color: "blue", collapsed: false });
        } else if (!state.groups.has(target)) {
          throw new Error(`No group with id: ${target}.`);
        } else if (ids.some((id) => state.windows.get(state.tabs.get(id)?.windowId)?.type === "popup")) {
          throw new Error("Tabs can only be moved to and from normal windows.");
        }
        for (const id of ids) {
          const tab = state.tabs.get(id);
          if (tab) setGroup(tab, target);
        }
        disposeEmptyGroups();
        return target;
      },
      async ungroup(tabIds) {
        for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = state.tabs.get(id);
          if (tab) setGroup(tab, -1);
        }
        disposeEmptyGroups();
      },
      onActivated: event(),
      async update(tabId, props) {
        const tab = state.tabs.get(tabId);
        if (!tab) throw new Error(`No tab with id: ${tabId}.`);
        if (props.active) {
          for (const other of state.tabs.values()) if (other.windowId === tab.windowId) other.active = false;
          tab.active = true;
          chrome.tabs.onActivated.fire({ tabId, windowId: tab.windowId });
        }
        return tabCopy(tab);
      },
      async sendMessage() {
        return { ok: true };
      }
    },
    tabGroups: {
      async get(groupId) {
        const group = state.groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        return { ...group };
      },
      async query(filter = {}) {
        return [...state.groups.values()]
          .filter((group) => (filter.windowId === undefined || group.windowId === filter.windowId) &&
            (filter.title === undefined || group.title === filter.title))
          .map((group) => ({ ...group }));
      },
      async update(groupId, props) {
        const group = state.groups.get(groupId);
        if (!group) throw new Error(`No group with id: ${groupId}.`);
        Object.assign(group, props);
        return { ...group };
      }
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      async attach(target) {
        state.attachCalls.push(target.tabId);
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (state.attached.has(target.tabId)) throw new Error("Another debugger is already attached to the tab");
        state.attached.add(target.tabId);
      },
      async detach(target) {
        state.attached.delete(target.tabId);
      },
      async sendCommand(target, method, params) {
        if (!state.attached.has(target.tabId)) throw new Error("Debugger is not attached to the tab");
        state.commands.push({ target: { ...target }, method, params });
        if (method === "Runtime.evaluate" && params?.expression === "BIG") {
          return { result: { type: "string", value: "x".repeat(5 * 1024 * 1024) } };
        }
        return { ok: true, method, sessionId: target.sessionId ?? null };
      },
      async getTargets() {
        return [...state.targets.entries()].map(([tabId, id]) => ({ id, tabId, type: "page", attached: state.attached.has(tabId) }));
      }
    },
    downloads: { onCreated: event(), onChanged: event() }
  };

  // Test helpers
  const helpers = {
    state,
    port,
    focusWindow(windowId) {
      for (const win of state.windows.values()) win.focused = win.id === windowId;
      state.lastFocusedWindowId = windowId;
    },
    activateTab(tabId) {
      const tab = state.tabs.get(tabId);
      for (const other of state.tabs.values()) if (other.windowId === tab.windowId) other.active = false;
      tab.active = true;
      chrome.tabs.onActivated.fire({ tabId, windowId: tab.windowId });
    },
    userTab(props = {}) {
      const id = state.nextTabId++;
      const tab = { id, windowId: 1, url: "https://user.example/", title: "user", active: false, groupId: -1, index: 0, ...props };
      state.tabs.set(id, tab);
      state.targets.set(id, `target-${id}`);
      return tab;
    },
    dragOutOfGroup(tabId) {
      setGroup(state.tabs.get(tabId), -1);
      disposeEmptyGroups();
    }
  };
  return { chrome, ...helpers };
}

// Loads the full background.js (including its top-level wiring) into a VM
// context backed by the fake. Returns the context globals the tests need.
export async function loadBackground(fake) {
  const source = await readFile(BACKGROUND_PATH, "utf8");
  const context = vm.createContext({
    chrome: fake.chrome,
    console: { ...console, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    TextEncoder,
    TextDecoder,
    structuredClone,
    crypto: globalThis.crypto,
    Date
  });
  vm.runInContext(
    `${source}\nglobalThis.__test = { backend, peer, transport, BrowserBackend, ChunkAssembler, BRAND, sessionGroupTitle };`,
    context,
    { filename: BACKGROUND_PATH }
  );
  await context.__test.backend.store.ready;
  return context.__test;
}

// Sends a JSON-RPC request through the fake native port and resolves with the
// extension's response.
export async function rpc(fake, method, params, { id = `t-${Math.random()}` } = {}) {
  const before = fake.state.posted.length;
  fake.port.onMessage.fire({ jsonrpc: "2.0", id, method, params });
  for (let i = 0; i < 400; i += 1) {
    const response = fake.state.posted.slice(before).find((message) => message.id === id);
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`No response for ${method}`);
}

export function notifications(fake, method) {
  return fake.state.posted.filter((message) => message.method === method).map((message) => message.params);
}

export async function settle(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
