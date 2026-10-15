// @obu-brand-begin — generated from apps/chrome-extension/brands/<brand>.json by
// scripts/package-chrome-extension-brand.mjs (OBU_BRAND=<brand>). Edit the JSON, not this block.
const BRAND = Object.freeze({
  "id": "default",
  "displayName": "Open Browser Use",
  "nativeHostName": "com.ifuryst.open_browser_use.extension",
  "groupTitle": "OBU",
  "groupColor": "grey",
  "deliverableGroupTitle": "OBU",
  "deliverableGroupColor": "grey"
});
// @obu-brand-end
const NATIVE_HOST_NAME = BRAND.nativeHostName;
const NATIVE_HOST_STATUS_KEY = "OPEN_BROWSER_USE_NATIVE_HOST_STATUS";
const SESSION_STATE_KEY = "OPEN_BROWSER_USE_SESSION_STATE";
const WEBMCP_ENABLED_KEY = "OPEN_BROWSER_USE_WEBMCP_ENABLED";
const RECONNECT_ALARM_NAME = "open-browser-use-native-reconnect";
const HEARTBEAT_ALARM_NAME = "open-browser-use-heartbeat";
const DEFAULT_CDP_TIMEOUT_MS = 10_000;
const DEFAULT_WEBMCP_TIMEOUT_MS = 10_000;
const DEFAULT_WEBMCP_LIST_TIMEOUT_MS = 5_000;
const WEBMCP_TIMEOUT_GRACE_MS = 1_500;
const CURSOR_ARRIVAL_TIMEOUT_MS = 1_000;
const MAX_USER_TABS = 1000;
const DEFAULT_SESSION_GROUP_TITLE = sessionGroupTitle();
const DELIVERABLE_GROUP_TITLE = BRAND.deliverableGroupTitle;
// Titles written by older builds ("Task - OBU", "Open Browser Use 1a2b3c4d",
// "<label> · OBU"); migrated to the brand title on load.
const LEGACY_SESSION_GROUP_TITLE_PATTERN = /^(Open Browser Use [0-9a-f]{8}|Task - OBU|.+ · [^·]+)$/i;
const LEGACY_DELIVERABLE_GROUP_TITLES = new Set(["✅ Open Browser Use"]);
// Idle chrome.debugger attachments are dropped so Chrome's
// '"<extension>" started debugging this browser' infobar goes away between
// bursts of agent work; the next CDP call re-attaches implicitly.
const DEFAULT_IDLE_DETACH_MS = 30_000;
// Backstop lease: a session with no request for this long (daemon crashed,
// host gone, client forgot to finalize) is finalized by the extension itself,
// closing its agent tabs. The daemon's own 60 s lease normally fires first.
const DEFAULT_SESSION_LEASE_MS = 5 * 60_000;
const LEASE_SWEEP_ALARM_NAME = "open-browser-use-lease-sweep";
// Host→extension native-messaging frames are capped at 1 MB by Chrome; the host
// splits larger JSON payloads into {chunk:{id,i,n,data}} slices (WS-B pairs).
const CHUNK_TTL_MS = 30_000;
const TARGET_ID_RETRY_DELAYS_MS = [0, 50, 100, 200, 400];
const DOWNLOAD_CORRELATION_WINDOW_MS = 15_000;
// Events the daemon must always see for a tab, regardless of its subscriptions:
// dialogs would hang the tab, child sessions/downloads/file choosers drive state.
const ALWAYS_FORWARDED_CDP_EVENTS = new Set([
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.fileChooserOpened",
  "Page.downloadWillBegin",
  "Page.downloadProgress",
  "Browser.downloadWillBegin",
  "Browser.downloadProgress",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
  "Target.targetCrashed",
  "Inspector.detached",
  "Inspector.targetCrashed"
]);
const ERROR_CODES = Object.freeze({
  profile_mismatch: -32010,
  tab_not_owned: -32011,
  close_guarded: -32012
});

class ExtensionError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// Agent groups carry only the brand mark (no task label, status or emoji);
// session labels are kept in storage for diagnostics but never shown.
function sessionGroupTitle() {
  return BRAND.groupTitle;
}
const WEBMCP_CAPABILITY = {
  id: "webmcp",
  description: "Fetch page-defined WebMCP tools bound to the current document and invoke them."
};
const WEBMCP_CONTENT_SCRIPTS = [
  {
    id: "open-browser-use-webmcp-main",
    js: ["content-webmcp-main.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: false,
    runAt: "document_start",
    world: "MAIN"
  },
  {
    id: "open-browser-use-webmcp-bridge",
    js: ["content-webmcp-bridge.js"],
    matches: ["<all_urls>"],
    persistAcrossSessions: false,
    runAt: "document_start",
    world: "ISOLATED"
  }
];

class JsonRpcPeer {
  constructor(transport, handlers) {
    this.transport = transport;
    this.handlers = handlers;
    this.transport.setMessageCallback((message) => {
      void this.handleMessage(message);
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      return;
    }
    const id = message.id;
    try {
      const handler = this.handlers[message.method];
      if (typeof handler !== "function") {
        throw new Error(`No handler registered for method: ${message.method}`);
      }
      const params = message.params ?? {};
      await this.checkRoute(params);
      const result = await handler.call(this.handlers, params);
      if (id !== undefined) {
        this.transport.sendMessage({ jsonrpc: "2.0", id, result: result ?? {} });
      }
    } catch (error) {
      if (id !== undefined) {
        this.transport.sendMessage({ jsonrpc: "2.0", id, error: toRpcError(error) });
      }
    }
  }

  // Requests may carry route{profileId}; one host can front several Chrome
  // profiles, so a request meant for another profile must never act here.
  async checkRoute(params) {
    const route = params && typeof params === "object" ? params.route : undefined;
    if (!route || typeof route !== "object" || route.profileId == null) {
      return;
    }
    const profileId = await this.handlers.getProfileId?.();
    if (route.profileId !== profileId) {
      throw new ExtensionError(
        ERROR_CODES.profile_mismatch,
        `profile_mismatch: request routed to profile ${String(route.profileId)}, this extension is ${profileId}`,
        { code: "profile_mismatch", expected: profileId, received: route.profileId }
      );
    }
  }

  sendNotification(method, params) {
    this.transport.sendMessage({ jsonrpc: "2.0", method, params });
  }
}

function toRpcError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ExtensionError) {
    return { code: error.code, message, ...(error.data ? { data: error.data } : {}) };
  }
  return { code: -32000, message };
}

// Reassembles host→extension frames split as {chunk:{id,i,n,data}} where data
// is the i-th slice of the JSON text of one message (0 ≤ i < n).
class ChunkAssembler {
  constructor({ now = () => Date.now(), ttlMs = CHUNK_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  // Returns the parsed message when complete, null while waiting, and the
  // input unchanged when it is not a chunk frame.
  accept(frame) {
    const chunk = frame && typeof frame === "object" ? frame.chunk : undefined;
    if (!chunk || typeof chunk !== "object") {
      return frame;
    }
    this.gc();
    const { id, i, n, data } = chunk;
    if (typeof id !== "string" || !Number.isInteger(i) || !Number.isInteger(n) || n <= 0 || i < 0 || i >= n || typeof data !== "string") {
      throw new Error("Malformed chunk frame");
    }
    let entry = this.pending.get(id);
    if (!entry) {
      entry = { n, parts: new Array(n), received: 0, at: this.now() };
      this.pending.set(id, entry);
    }
    if (entry.n !== n) {
      this.pending.delete(id);
      throw new Error(`Chunk ${id} changed part count`);
    }
    if (entry.parts[i] === undefined) {
      entry.parts[i] = data;
      entry.received += 1;
    }
    if (entry.received < entry.n) {
      return null;
    }
    this.pending.delete(id);
    return JSON.parse(entry.parts.join(""));
  }

  gc() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.pending) {
      if (entry.at < cutoff) {
        this.pending.delete(id);
      }
    }
  }
}

class NativeTransport {
  constructor(hostName) {
    this.hostName = hostName;
    this.port = null;
    this.messageCallback = null;
    this.chunks = new ChunkAssembler();
    this.reconnectAttempt = 0;
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      state: "disconnected"
    };
    this.connect();
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM_NAME && !this.port) {
        this.connect();
      }
    });
  }

  setMessageCallback(callback) {
    this.messageCallback = callback;
  }

  sendMessage(message) {
    if (!this.port) {
      this.scheduleReconnect("native host disconnected");
      throw new Error("Native host is disconnected");
    }
    this.port.postMessage(message);
  }

  connect() {
    if (this.port) {
      return;
    }
    try {
      const port = chrome.runtime.connectNative(this.hostName);
      this.port = port;
      this.reconnectAttempt = 0;
      this.setStatus({ state: "connected" });
      port.onMessage.addListener((frame) => {
        let message;
        try {
          message = this.chunks.accept(frame);
        } catch (error) {
          console.warn("Dropping native frame:", error);
          return;
        }
        if (message !== null) {
          this.messageCallback?.(message);
        }
      });
      port.onDisconnect.addListener(() => {
        this.port = null;
        this.scheduleReconnect(chrome.runtime.lastError?.message ?? "native host disconnected");
      });
    } catch (error) {
      this.port = null;
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
    }
  }

  scheduleReconnect(error) {
    this.reconnectAttempt += 1;
    this.setStatus({
      state: "reconnecting",
      error,
      nextRetryMs: 5000,
      reconnectAttempt: this.reconnectAttempt
    });
    chrome.alarms.create(RECONNECT_ALARM_NAME, { periodInMinutes: 0.1 }).catch(() => {});
  }

  setStatus(status) {
    this.status = {
      hostName: this.hostName,
      lastChecked: Date.now(),
      reconnectAttempt: this.reconnectAttempt,
      ...status
    };
    chrome.storage.local
      .set({
        [NATIVE_HOST_STATUS_KEY]: this.status
      })
      .catch(() => {});
  }

  getStatus() {
    return this.status;
  }
}

class SessionStore {
  constructor() {
    this.state = { sessions: {}, deliverableGroupId: null };
    this.ready = this.load();
  }

  async load() {
    const stored = await chrome.storage.local.get(SESSION_STATE_KEY);
    const value = stored[SESSION_STATE_KEY];
    if (value && typeof value === "object") {
      this.state = {
        sessions: value.sessions && typeof value.sessions === "object" ? value.sessions : {},
        deliverableGroupId:
          typeof value.deliverableGroupId === "number" ? value.deliverableGroupId : null
      };
      let migrated = false;
      for (const session of Object.values(this.state.sessions)) {
        if (
          session &&
          typeof session === "object" &&
          typeof session.title === "string" &&
          session.title !== DEFAULT_SESSION_GROUP_TITLE &&
          LEGACY_SESSION_GROUP_TITLE_PATTERN.test(session.title)
        ) {
          session.title = DEFAULT_SESSION_GROUP_TITLE;
          migrated = true;
        }
      }
      if (migrated) {
        await this.save();
        for (const session of Object.values(this.state.sessions)) {
          if (typeof session?.chromeGroupId === "number") {
            await chrome.tabGroups?.update?.(session.chromeGroupId, { title: session.title }).catch(() => {});
          }
        }
      }
      if (typeof this.state.deliverableGroupId === "number") {
        await chrome.tabGroups
          .update(this.state.deliverableGroupId, { title: DELIVERABLE_GROUP_TITLE, color: BRAND.deliverableGroupColor })
          .catch(() => {});
      }
    }
  }

  async save() {
    await chrome.storage.local.set({ [SESSION_STATE_KEY]: this.state });
  }

  // A child session (parentSessionId) shares its root's tab group and bound
  // window but owns its own tabs (tabOrigins) — subagents never see each
  // other's tabs through getTabs.
  async getSession(sessionId, { parentSessionId, label } = {}) {
    await this.ready;
    const existing = this.state.sessions[sessionId];
    if (existing && typeof existing === "object") {
      return existing;
    }
    let rootSessionId = null;
    if (typeof parentSessionId === "string" && parentSessionId && parentSessionId !== sessionId) {
      const parent = await this.getSession(parentSessionId);
      rootSessionId = parent.rootSessionId ?? parentSessionId;
    }
    const created = {
      chromeGroupId: null,
      windowId: null,
      title: DEFAULT_SESSION_GROUP_TITLE,
      ...(label ? { label } : {}),
      activeTabId: null,
      tabOrigins: {},
      ...(rootSessionId ? { rootSessionId, parentSessionId } : {})
    };
    this.state.sessions[sessionId] = created;
    await this.save();
    return created;
  }

  async getRoot(sessionId) {
    const session = await this.getSession(sessionId);
    const rootSessionId = session.rootSessionId ?? sessionId;
    return { rootSessionId, root: rootSessionId === sessionId ? session : await this.getSession(rootSessionId) };
  }

  async findTabOwner(tabId) {
    await this.ready;
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      if (session?.tabOrigins && Object.hasOwn(session.tabOrigins, String(tabId))) {
        return { sessionId, session, origin: session.tabOrigins[String(tabId)] };
      }
    }
    return null;
  }

  async removeSession(sessionId) {
    await this.ready;
    delete this.state.sessions[sessionId];
    await this.save();
  }

  async findSessionByGroup(groupId) {
    await this.ready;
    for (const [sessionId, session] of Object.entries(this.state.sessions)) {
      if (session.chromeGroupId === groupId) {
        return { sessionId, session };
      }
    }
    return null;
  }
}

class WebMcpGate {
  constructor() {
    this.enabledValue = false;
    this.applyQueue = Promise.resolve(false);
    this.ready = this.refresh();
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== "local" || !Object.hasOwn(changes, WEBMCP_ENABLED_KEY)) {
        return;
      }
      const enabled = changes[WEBMCP_ENABLED_KEY]?.newValue !== false;
      this.ready = this.queueApply(enabled);
    });
  }

  async enabled() {
    await this.ready;
    return this.enabledValue;
  }

  async refresh() {
    try {
      const stored = await chrome.storage.local.get(WEBMCP_ENABLED_KEY);
      return await this.queueApply(stored[WEBMCP_ENABLED_KEY] !== false);
    } catch {
      this.enabledValue = false;
      return false;
    }
  }

  queueApply(enabled) {
    this.applyQueue = this.applyQueue
      .catch(() => false)
      .then(async () => await this.apply(enabled));
    return this.applyQueue;
  }

  async apply(enabled) {
    if (
      typeof chrome.scripting?.getRegisteredContentScripts !== "function" ||
      typeof chrome.scripting?.registerContentScripts !== "function" ||
      typeof chrome.scripting?.unregisterContentScripts !== "function"
    ) {
      this.enabledValue = false;
      return false;
    }
    const ids = WEBMCP_CONTENT_SCRIPTS.map((script) => script.id);
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids });
    if (registered.length > 0) {
      await chrome.scripting.unregisterContentScripts({ ids: registered.map((script) => script.id) });
    }
    if (enabled) {
      await chrome.scripting.registerContentScripts(WEBMCP_CONTENT_SCRIPTS);
    }
    this.enabledValue = enabled;
    return enabled;
  }
}

class BrowserBackend {
  constructor({ webMcpGate = null } = {}) {
    this.store = new SessionStore();
    this.webMcpGate = webMcpGate;
    this.attachedTabs = new Set();
    this.activeTabsBySession = new Map();
    this.cursorByTabId = new Map();
    this.downloadFilenamesById = new Map();
    this.downloadUrlsById = new Map();
    this.downloadContextById = new Map();
    this.downloadsById = new Map();
    this.downloadWaiters = new Set();
    this.downloadChangeListeners = new Set();
    this.cursorArrivalWaitersByKey = new Map();
    this.fileChoosersById = new Map();
    this.fileChooserWaitersByTabId = new Map();
    this.nextCursorMoveSequence = 1;
    // Serialises every tab-group mutation: concurrent chrome.tabs.group calls
    // for one session would otherwise race into duplicate groups.
    this.groupQueue = Promise.resolve();
    // sessionId -> Map<tabId, Set<domain>>; "*" subscribes to every domain.
    this.subscriptions = new Map();
    this.attachingTabs = new Map();
    this.targetIdByTabId = new Map();
    this.recentDownloadBegins = [];
    this.notify = null;
    this.profileId = null;
    this.idleDetachMs = DEFAULT_IDLE_DETACH_MS;
    // windowId -> recently activated tab ids (newest last), to hand focus back
    // when an agent-opened popup grabs it.
    this.activationHistory = new Map();
    this.sessionLeaseMs = DEFAULT_SESSION_LEASE_MS;
    this.lastAgentAction = null;
    this.idleTimers = new Map();
    this.inflightByTab = new Map();
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (typeof source.tabId === "number") {
        this.attachedTabs.delete(source.tabId);
        this.clearIdleTimer(source.tabId);
        // e.g. the user pressed Cancel on Chrome's debugging infobar.
        this.emit("debuggerDetached", { tabId: source.tabId, reason: reason ?? "detached" });
      }
    });
  }

  ping() {
    return "pong";
  }

  async getProfileId() {
    if (this.profileId) {
      return this.profileId;
    }
    let { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
    if (typeof extensionInstanceId !== "string") {
      extensionInstanceId = crypto.randomUUID();
      await chrome.storage.local.set({ extensionInstanceId });
    }
    this.profileId = extensionInstanceId;
    return extensionInstanceId;
  }

  emit(method, params) {
    try {
      this.notify?.(method, params);
    } catch {}
  }

  // configure{idleDetachMs}: 0 disables idle detach (keep attached until the
  // turn ends); default DEFAULT_IDLE_DETACH_MS.
  async configure(params) {
    if (params.sessionLeaseMs !== undefined) {
      if (!Number.isInteger(params.sessionLeaseMs) || params.sessionLeaseMs < 0) {
        throw new Error("configure sessionLeaseMs must be a non-negative integer");
      }
      this.sessionLeaseMs = params.sessionLeaseMs;
    }
    if (params.idleDetachMs !== undefined) {
      if (!Number.isInteger(params.idleDetachMs) || params.idleDetachMs < 0) {
        throw new Error("configure idleDetachMs must be a non-negative integer");
      }
      this.idleDetachMs = params.idleDetachMs;
      for (const tabId of this.attachedTabs) this.touchTab(tabId);
    }
    return { idleDetachMs: this.idleDetachMs, sessionLeaseMs: this.sessionLeaseMs };
  }

  clearIdleTimer(tabId) {
    const timer = this.idleTimers.get(tabId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(tabId);
    }
  }

  // Restart the idle-detach clock for an attached tab.
  touchTab(tabId) {
    this.clearIdleTimer(tabId);
    if (!this.attachedTabs.has(tabId) || this.idleDetachMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(tabId);
      void this.detachIfIdle(tabId);
    }, this.idleDetachMs);
    timer?.unref?.();
    this.idleTimers.set(tabId, timer);
  }

  async detachIfIdle(tabId) {
    if (!this.attachedTabs.has(tabId)) {
      return;
    }
    if ((this.inflightByTab.get(tabId) ?? 0) > 0 || this.fileChooserWaitersByTabId.has(tabId)) {
      this.touchTab(tabId);
      return;
    }
    await this.detachTab(tabId).catch(() => {});
    this.emit("debuggerDetached", { tabId, reason: "idle" });
  }

  queueGroupOp(fn) {
    const run = this.groupQueue.then(fn, fn);
    this.groupQueue = run.catch(() => {});
    return run;
  }

  async getInfo() {
    const extensionInstanceId = await this.getProfileId();
    const webMcpEnabled = (await this.webMcpGate?.enabled?.()) === true;
    return {
      name: `${BRAND.displayName} Chrome`,
      version: chrome.runtime.getManifest().version,
      type: "extension",
      capabilities: {
        tab: webMcpEnabled ? [WEBMCP_CAPABILITY] : [],
        // Agent-wire v2 features (docs: apps/chrome-extension/WIRE.md).
        wire: [
          "cdp-child-sessions",
          "implicit-attach",
          "subscribe",
          "chunked-frames",
          "route",
          "lease-events",
          "popup-adoption",
          "download-correlation",
          "close-guard"
        ]
      },
      metadata: {
        extensionId: chrome.runtime.id,
        extensionInstanceId,
        profileId: extensionInstanceId,
        brand: BRAND.id,
        nativeHostName: NATIVE_HOST_NAME
      }
    };
  }

  async createTab(params) {
    const session = await this.requireSession(params);
    const { root } = await this.store.getRoot(session.sessionId);
    const url = typeof params.url === "string" && params.url ? params.url : "about:blank";
    const chromeTab = await createBackgroundTab(root, url);
    await this.ensureSessionGroup(session.sessionId, chromeTab.id, "agent");
    await this.setSessionActiveTab(session.sessionId, chromeTab.id);
    const targetId = await this.lookupTargetId(chromeTab.id).catch(() => null);
    return { ...toBrowserTab(chromeTab), active: true, ...(targetId ? { targetId } : {}) };
  }

  // tabId → CDP targetId via chrome.debugger.getTargets (the target may appear
  // a beat after tabs.create resolves, hence the short retry ladder).
  async lookupTargetId(tabId) {
    const cached = this.targetIdByTabId.get(tabId);
    if (cached) {
      return cached;
    }
    for (const delay of TARGET_ID_RETRY_DELAYS_MS) {
      if (delay > 0) {
        await sleep(delay);
      }
      const targets = await chrome.debugger.getTargets();
      const match = targets.find((target) => target.tabId === tabId && target.type === "page") ??
        targets.find((target) => target.tabId === tabId);
      if (match?.id) {
        this.targetIdByTabId.set(tabId, match.id);
        return match.id;
      }
    }
    return null;
  }

  async getTargetId(params) {
    await this.requireSessionTab(params, "getTargetId");
    const tabId = requireTabId(params, "getTargetId");
    return { tabId, targetId: await this.lookupTargetId(tabId) };
  }

  // Closes one owned agent tab, honouring the close guard: never close a tab
  // the user is looking at (active in the focused window) or one that has left
  // the session's group; such a tab is released to the user instead.
  async closeTab(params) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "closeTab");
    const owner = await this.store.findTabOwner(tabId);
    if (!owner || owner.sessionId !== session.sessionId) {
      throw new ExtensionError(ERROR_CODES.tab_not_owned, `tab_not_owned: tab ${tabId} is not owned by browser session ${session.sessionId}`, { code: "tab_not_owned", tabId });
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // `force` (agent-initiated close of its own tab): skip the on-screen guard,
    // but never close a tab the user took out of the agent group.
    let guard = tab ? await this.closeGuard(session.sessionId, tab, owner.origin) : null;
    if (params.force === true && guard === "user_viewing") guard = null;
    delete owner.session.tabOrigins[String(tabId)];
    this.dropTabState(session.sessionId, tabId);
    await this.store.save();
    if (!tab) {
      return { closed: false, released: false, reason: "gone" };
    }
    await this.detachMany([tabId]);
    if (owner.origin === "user" || guard) {
      await this.queueGroupOp(() => chrome.tabs.ungroup?.(tabId)).catch(() => {});
      return { closed: false, released: true, reason: owner.origin === "user" ? "borrowed" : guard };
    }
    await chrome.tabs.remove(tabId);
    return { closed: true, released: false };
  }

  // Returns null when the tab may be closed, or the reason it may not.
  async closeGuard(sessionId, tab, origin) {
    const { root } = await this.store.getRoot(sessionId);
    const inGroup = typeof root.chromeGroupId === "number" && tab.groupId === root.chromeGroupId;
    // Popup-window tabs cannot be grouped; they stay closable while ungrouped.
    if (!inGroup && !(origin === "popup" && (tab.groupId ?? -1) === -1)) {
      return "left_group";
    }
    // The active tab of any non-minimized window may be on screen even when
    // Chrome is not frontmost; never pull it out from under the user.
    // Agent popup windows (auth flows etc.) are transient: always closable.
    if (tab.active && origin !== "popup") {
      const win = await chrome.windows?.get?.(tab.windowId).catch(() => null);
      if (!win || win.state !== "minimized") {
        return "user_viewing";
      }
    }
    return null;
  }

  dropTabState(sessionId, tabId) {
    this.cursorByTabId.delete(tabId);
    this.targetIdByTabId.delete(tabId);
    this.subscriptions.get(sessionId)?.delete(tabId);
    if (this.activeTabsBySession.get(sessionId) === tabId) {
      this.activeTabsBySession.delete(sessionId);
    }
  }

  // Per-session CDP event subscription. Events for a tab nobody subscribed to
  // are still broadcast (legacy clients); once any session subscribes to a tab
  // only the listed domains (plus ALWAYS_FORWARDED_CDP_EVENTS) flow for it.
  async subscribe(params) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "subscribe");
    await this.requireSessionTab(params, "subscribe");
    if (!Array.isArray(params.domains) || params.domains.some((domain) => typeof domain !== "string" || !domain)) {
      throw new Error("subscribe requires domains to be an array of non-empty strings");
    }
    let tabs = this.subscriptions.get(session.sessionId);
    if (!tabs) {
      tabs = new Map();
      this.subscriptions.set(session.sessionId, tabs);
    }
    tabs.set(tabId, new Set(params.domains));
    return { tabId, domains: [...tabs.get(tabId)] };
  }

  async unsubscribe(params) {
    const session = await this.requireSession(params);
    const tabs = this.subscriptions.get(session.sessionId);
    if (Number.isInteger(params.tabId)) {
      tabs?.delete(params.tabId);
    } else {
      this.subscriptions.delete(session.sessionId);
    }
    if (tabs && tabs.size === 0) {
      this.subscriptions.delete(session.sessionId);
    }
  }

  // Returns the subscriber session ids for an event, [] when it should be
  // dropped, or null for legacy broadcast (nobody subscribed to this tab).
  cdpEventSubscribers(source, method) {
    const tabId = source?.tabId;
    const domain = typeof method === "string" ? method.split(".")[0] : "";
    const subscribers = [];
    let anySubscription = false;
    for (const [sessionId, tabs] of this.subscriptions) {
      const domains = tabs.get(tabId);
      if (!domains) continue;
      anySubscription = true;
      if (domains.has("*") || domains.has(domain) || ALWAYS_FORWARDED_CDP_EVENTS.has(method)) {
        subscribers.push(sessionId);
      }
    }
    if (!anySubscription) {
      return null;
    }
    return subscribers;
  }

  async getTabs(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    return await this.withLogicalActive(session.sessionId, tabs.map(toBrowserTab));
  }

  async getUserTabs(params) {
    await this.requireSession(params);
    const tabs = (await chrome.tabs.query({}))
      .filter(hasTabId)
      .sort(compareLastAccessed)
      .slice(0, MAX_USER_TABS);
    const groupTitles = await readGroupTitles(tabs);
    return tabs.map((tab) => toUserTab(tab, groupTitles));
  }

  /**
   * Search retained history for one or more terms.
   * Merges matches by URL (newest visit wins) and applies a single limit.
   */
  async getUserHistory(params) {
    await this.requireSession(params);
    if (params.queries == null && params.query != null && typeof params.query !== "string") {
      throw new Error("getUserHistory requires query to be a string");
    }
    const queries = params.queries ?? [params.query ?? ""];
    if (!Array.isArray(queries) || queries.length === 0) {
      throw new Error("getUserHistory requires queries to be a non-empty array of strings");
    }
    for (const query of queries) {
      if (typeof query !== "string") {
        throw new Error("getUserHistory requires queries to be a non-empty array of strings");
      }
    }
    const maxResults = optionalPositiveInteger(params.limit ?? undefined, 100, "getUserHistory limit");
    // Chrome searches only the last 24 hours when startTime is omitted.
    const search = { maxResults, startTime: 0 };
    for (const [field, key] of [["from", "startTime"], ["to", "endTime"]]) {
      if (params[field] == null) continue;
      if (typeof params[field] !== "string") {
        throw new Error(`getUserHistory requires ${field} to be a valid date`);
      }
      search[key] = parseDate(params[field], field);
    }
    if (search.endTime !== undefined && search.endTime < search.startTime) {
      throw new Error("getUserHistory requires to >= from");
    }
    const batches = await Promise.all(
      [...new Set(queries)].map((text) => chrome.history.search({ ...search, text }))
    );
    const seenUrls = new Set();
    return batches
      .flat()
      .filter((item) =>
        typeof item?.url === "string" &&
        typeof item.lastVisitTime === "number" &&
        Number.isFinite(new Date(item.lastVisitTime).getTime())
      )
      .sort((left, right) => right.lastVisitTime - left.lastVisitTime)
      .filter(({ url }) => {
        if (seenUrls.has(url)) return false;
        seenUrls.add(url);
        return true;
      })
      .slice(0, maxResults)
      .map((item) => ({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        dateVisited: new Date(item.lastVisitTime).toISOString()
      }));
  }

  async claimUserTab(params) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, "claimUserTab");
    const tab = await chrome.tabs.get(tabId);
    if (!hasTabId(tab)) {
      throw new Error(`Chrome tab ${tabId} has no id`);
    }
    if (tab.url?.startsWith("chrome://")) {
      throw new Error(`Chrome internal tab ${tabId} cannot be claimed`);
    }
    const tabOwner = await this.store.findTabOwner(tabId);
    if (tabOwner && tabOwner.sessionId !== session.sessionId) {
      throw new ExtensionError(ERROR_CODES.tab_not_owned, `Tab ${tabId} is already part of browser session ${tabOwner.sessionId}`, { code: "tab_not_owned", tabId, owner: tabOwner.sessionId });
    }
    if (!tabOwner && typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      const { rootSessionId } = await this.store.getRoot(session.sessionId);
      if (owner && owner.sessionId !== rootSessionId) {
        throw new ExtensionError(ERROR_CODES.tab_not_owned, `Tab ${tabId} is already part of browser session ${owner.sessionId}`, { code: "tab_not_owned", tabId, owner: owner.sessionId });
      }
    }
    await this.ensureSessionGroup(session.sessionId, tab.id, tabOwner?.origin ?? "user");
    await this.setSessionActiveTab(session.sessionId, tab.id);
    return { ...toBrowserTab(tab), active: true };
  }

  async finalizeTabs(params) {
    const session = await this.requireSession(params);
    if (!Array.isArray(params.keep)) {
      throw new Error("finalizeTabs requires keep array");
    }
    const tabs = await this.getSessionTabs(session.sessionId);
    const knownTabIds = new Set(tabs.filter(hasTabId).map((tab) => tab.id));
    const keep = new Map();
    for (const entry of params.keep) {
      if (!entry || typeof entry !== "object") {
        throw new Error("finalizeTabs received invalid tab entry");
      }
      const tabId = requireTabId(entry, "finalizeTabs");
      if (!knownTabIds.has(tabId)) {
        throw new Error(`finalizeTabs cannot keep unknown tab ${tabId}`);
      }
      if (keep.has(tabId)) {
        throw new Error(`finalizeTabs received duplicate tab ${tabId}`);
      }
      const status = entry.status;
      if (status !== "handoff" && status !== "deliverable") {
        throw new Error(`finalizeTabs received invalid status ${String(status)}`);
      }
      keep.set(tabId, status);
    }
    const sessionState = await this.store.getSession(session.sessionId);
    const agentTabsToClose = [];
    const userTabsToRelease = [];
    const deliverableTabs = [];
    const handoffTabs = [];
    const guardedTabs = [];
    for (const tab of tabs) {
      if (!hasTabId(tab)) {
        continue;
      }
      const keptStatus = keep.get(tab.id);
      if (keptStatus === "handoff") {
        handoffTabs.push(tab.id);
        continue;
      }
      if (keptStatus === "deliverable") {
        deliverableTabs.push(tab.id);
        continue;
      }
      const origin = sessionState.tabOrigins[String(tab.id)];
      if (origin === "agent" || origin === "popup") {
        const guard = await this.closeGuard(session.sessionId, tab, origin);
        if (guard) {
          userTabsToRelease.push(tab.id);
          guardedTabs.push({ tabId: tab.id, reason: guard });
        } else {
          agentTabsToClose.push(tab.id);
        }
      } else {
        userTabsToRelease.push(tab.id);
      }
    }
    // Drop ownership before mutating Chrome so our own ungroup/remove events
    // are not mistaken for the user revoking a lease.
    for (const tabId of [...agentTabsToClose, ...userTabsToRelease, ...deliverableTabs]) {
      delete sessionState.tabOrigins[String(tabId)];
      this.dropTabState(session.sessionId, tabId);
    }
    await this.store.save();
    // Detach every disposition, including handoff tabs we keep alive: leaving a
    // tab attached keeps Chrome's "started debugging this browser" banner up
    // after the turn ends. The debugger re-attaches lazily on the next CDP call
    // (the CLI runner and background handlers attach on demand), so dropping it
    // here is loss-free while clearing the banner.
    await this.detachMany([
      ...agentTabsToClose,
      ...userTabsToRelease,
      ...deliverableTabs,
      ...handoffTabs
    ]);
    if (agentTabsToClose.length > 0) {
      await chrome.tabs.remove(agentTabsToClose.length === 1 ? agentTabsToClose[0] : agentTabsToClose);
    }
    if (userTabsToRelease.length > 0 && chrome.tabs.ungroup) {
      await this.queueGroupOp(() =>
        chrome.tabs.ungroup(userTabsToRelease.length === 1 ? userTabsToRelease[0] : userTabsToRelease)
      );
    }
    if (deliverableTabs.length > 0) {
      await this.queueGroupOp(() => this.moveToDeliverables(deliverableTabs));
    }
    if (handoffTabs.length > 0) {
      sessionState.handoffTabIds = handoffTabs;
      sessionState.activeTabId = handoffTabs.includes(sessionState.activeTabId)
        ? sessionState.activeTabId
        : handoffTabs[0];
      this.activeTabsBySession.set(session.sessionId, sessionState.activeTabId);
      await this.store.save();
    } else {
      this.activeTabsBySession.delete(session.sessionId);
      this.subscriptions.delete(session.sessionId);
      const hasChildren = Object.values(this.store.state.sessions).some(
        (other) => other?.rootSessionId === session.sessionId
      );
      if (hasChildren) {
        // Live subagents still use this root's group; keep it, drop the rest.
        sessionState.activeTabId = null;
        await this.store.save();
      } else {
        await this.store.removeSession(session.sessionId);
      }
    }
    return {
      closedTabIds: agentTabsToClose,
      releasedTabIds: userTabsToRelease,
      keptTabIds: [...handoffTabs, ...deliverableTabs],
      guardedTabs
    };
  }

  async nameSession(params) {
    const session = await this.requireSession(params);
    // The group shows only the brand mark; the name is kept as the session's
    // label (diagnostics) and the group title is re-asserted in case it drifted.
    const { rootSessionId, root } = await this.store.getRoot(session.sessionId);
    const sessionState = await this.store.getSession(session.sessionId);
    if (typeof params.name === "string" && params.name.trim()) {
      sessionState.label = params.name.trim();
    }
    if (rootSessionId === session.sessionId) {
      root.title = sessionGroupTitle();
    }
    await this.store.save();
    if (rootSessionId === session.sessionId && typeof root.chromeGroupId === "number") {
      await this.queueGroupOp(() => chrome.tabGroups.update(root.chromeGroupId, { title: root.title })).catch(() => {});
    }
  }

  async attach(params) {
    await this.requireSessionTab(params, "attach");
    const tabId = requireTabId(params, "attach");
    const alreadyAttached = this.attachedTabs.has(tabId);
    await this.ensureAttached(tabId);
    return { tabId, alreadyAttached };
  }

  // Idempotent and safe under concurrency: parallel calls share one attach.
  async ensureAttached(tabId) {
    if (this.attachedTabs.has(tabId)) {
      return;
    }
    let pending = this.attachingTabs.get(tabId);
    if (!pending) {
      pending = (async () => {
        try {
          await chrome.debugger.attach({ tabId }, "1.3");
        } catch (error) {
          if (!String(error?.message ?? error).includes("Another debugger")) {
            throw error;
          }
        }
        this.attachedTabs.add(tabId);
        // Fresh attachment: CDP state (domains, auto-attach, isolated worlds)
        // starts empty; the daemon re-runs its attach sequence on this event.
        this.emit("debuggerAttached", { tabId });
      })().finally(() => this.attachingTabs.delete(tabId));
      this.attachingTabs.set(tabId, pending);
    }
    await pending;
    this.touchTab(tabId);
  }

  async detach(params) {
    await this.requireSessionTab(params, "detach");
    const tabId = requireTabId(params, "detach");
    await this.detachTab(tabId);
  }

  async executeCdp(params) {
    await this.requireSession(params);
    const rawTarget = params.target && typeof params.target === "object" ? params.target : {};
    const tabId = rawTarget.tabId;
    // target.sessionId addresses a flat child session (OOPIF / worker) that was
    // auto-attached under this tab (chrome.debugger DebuggerSession, Chrome ≥ 125).
    const target = { ...rawTarget };
    if (target.sessionId === undefined || target.sessionId === null || target.sessionId === "") {
      delete target.sessionId;
    } else if (typeof target.sessionId !== "string") {
      throw new Error("executeCdp target.sessionId must be a string");
    }
    if (typeof tabId === "number") {
      await this.requireSessionTab({ ...params, tabId }, "executeCdp");
      // Implicit attach: no separate `attach` round trip before the first command.
      if (!this.attachedTabs.has(tabId)) {
        await this.ensureAttached(tabId);
      }
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    if (typeof tabId === "number") {
      this.inflightByTab.set(tabId, (this.inflightByTab.get(tabId) ?? 0) + 1);
      this.lastAgentAction = { tabId, sessionId: params.session_id, at: Date.now() };
    }
    try {
      return await this.sendCdp(target, params, timeoutMs);
    } finally {
      if (typeof tabId === "number") {
        const left = (this.inflightByTab.get(tabId) ?? 1) - 1;
        if (left > 0) this.inflightByTab.set(tabId, left);
        else this.inflightByTab.delete(tabId);
        this.touchTab(tabId);
      }
    }
  }

  async sendCdp(target, params, timeoutMs) {
    return await withTimeout(timeoutMs, async () => {
      if (params.method === "Target.getTargets") {
        return { targetInfos: await chrome.debugger.getTargets() };
      }
      if (typeof params.method !== "string") {
        throw new Error("executeCdp requires method");
      }
      return await chrome.debugger.sendCommand(target, params.method, params.commandParams ?? {});
    });
  }

  async webmcp_list_tools(params) {
    const tabId = requireWebMcpTabId(params, "webmcp_list_tools");
    await this.requireSessionTab({ ...params, tabId }, "webmcp_list_tools");
    await this.requireWebMcpEnabled();
    const result = await this.sendWebMcpRequest(
      tabId,
      { action: "list" },
      DEFAULT_WEBMCP_LIST_TIMEOUT_MS + WEBMCP_TIMEOUT_GRACE_MS
    );
    if (!result || typeof result !== "object" || !Array.isArray(result.tools)) {
      throw new Error("WebMCP list response did not include tools");
    }
    return result;
  }

  async webmcp_invoke_tool(params) {
    const tabId = requireWebMcpTabId(params, "webmcp_invoke_tool");
    await this.requireSessionTab({ ...params, tabId }, "webmcp_invoke_tool");
    await this.requireWebMcpEnabled();
    const toolName = requireNonEmptyString(params.tool_name, "webmcp_invoke_tool requires tool_name");
    const registrationId = requireNonEmptyString(
      params.registration_id,
      "webmcp_invoke_tool requires registration_id"
    );
    if (!Object.hasOwn(params, "input")) {
      throw new Error("webmcp_invoke_tool requires input");
    }
    const timeoutMs = optionalPositiveInteger(
      params.timeout_ms,
      DEFAULT_WEBMCP_TIMEOUT_MS,
      "webmcp_invoke_tool timeout_ms"
    );
    const result = await this.sendWebMcpRequest(
      tabId,
      {
        action: "invoke",
        tool_name: toolName.trim(),
        ...(typeof params.tool_description === "string"
          ? { tool_description: params.tool_description }
          : {}),
        ...(typeof params.tool_title === "string" ? { tool_title: params.tool_title } : {}),
        registration_id: registrationId.trim(),
        input: params.input,
        timeout_ms: timeoutMs
      },
      timeoutMs + WEBMCP_TIMEOUT_GRACE_MS
    );
    if (!result || typeof result !== "object" || !Object.hasOwn(result, "result")) {
      throw new Error("WebMCP invoke response did not include result");
    }
    return result;
  }

  async moveMouse(params) {
    const session = await this.requireSession(params);
    await this.requireSessionTab(params, "moveMouse");
    const tabId = requireTabId(params, "moveMouse");
    if (!Number.isFinite(params.x) || !Number.isFinite(params.y)) {
      throw new Error("moveMouse requires finite x and y");
    }
    const cursorReady = await this.ensureCursorContentScript(session.sessionId, tabId);
    if (!cursorReady) {
      throw new Error(`Cannot inject cursor content script into tab ${tabId}`);
    }
    const moveSequence = this.nextCursorMoveSequence;
    this.nextCursorMoveSequence += 1;
    const cursor = {
      moveSequence,
      visible: true,
      x: params.x,
      y: params.y
    };
    this.cursorByTabId.set(tabId, cursor);
    const arrivalWaiter =
      params.waitForArrival === false
        ? null
        : this.createCursorArrivalWaiter(params.session_id, params.turn_id, moveSequence);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR",
        sessionId: params.session_id,
        turnId: params.turn_id,
        moveSequence,
        x: cursor.x,
        y: cursor.y,
        visible: cursor.visible
      });
      await arrivalWaiter?.promise;
    } catch (error) {
      arrivalWaiter?.cancel();
      throw error;
    }
  }

  async waitForFileChooser(params) {
    await this.requireSessionTab(params, "waitForFileChooser");
    const tabId = requireTabId(params, "waitForFileChooser");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const waitForEvent = this.waitForFileChooserEvent(tabId);
    try {
      await chrome.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", {
        enabled: true
      });
      return await withTimeout(timeoutMs, () => waitForEvent);
    } finally {
      this.fileChooserWaitersByTabId.delete(tabId);
      await chrome.debugger
        .sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => {});
    }
  }

  async setFileChooserFiles(params) {
    await this.requireSession(params);
    if (typeof params.fileChooserId !== "string" || params.fileChooserId === "") {
      throw new Error("setFileChooserFiles requires fileChooserId");
    }
    const chooser = this.fileChoosersById.get(params.fileChooserId);
    if (!chooser) {
      throw new Error(`Unknown file chooser id "${params.fileChooserId}"`);
    }
    await this.requireSessionTab({ ...params, tabId: chooser.tabId }, "setFileChooserFiles");
    if (!Array.isArray(params.files) || params.files.length === 0) {
      throw new Error("setFileChooserFiles requires at least one file");
    }
    const files = params.files.map((file) => {
      if (typeof file !== "string" || file === "") {
        throw new Error("setFileChooserFiles files must be non-empty strings");
      }
      return file;
    });
    if (!chooser.isMultiple && files.length > 1) {
      throw new Error("File chooser does not accept multiple files");
    }
    await chrome.debugger.sendCommand({ tabId: chooser.tabId }, "DOM.setFileInputFiles", {
      backendNodeId: chooser.backendNodeId,
      files
    });
    this.fileChoosersById.delete(params.fileChooserId);
  }

  async waitForDownload(params) {
    await this.requireSessionTab(params, "waitForDownload");
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const download = await this.waitForDownloadChange(
      (change) =>
        change.status === "started" ||
        change.status === "in_progress" ||
        change.status === "complete",
      timeoutMs,
      "Timed out waiting for download."
    );
    return { downloadId: download.id };
  }

  async downloadPath(params) {
    await this.requireSession(params);
    if (typeof params.downloadId !== "string" || params.downloadId === "") {
      throw new Error("downloadPath requires downloadId");
    }
    const current = this.downloadsById.get(params.downloadId);
    if (current?.status === "complete") {
      return { path: current.filename ?? null };
    }
    if (current?.status === "failed" || current?.status === "canceled") {
      return { path: null };
    }
    const timeoutMs =
      typeof params.timeoutMs === "number" && params.timeoutMs > 0
        ? params.timeoutMs
        : DEFAULT_CDP_TIMEOUT_MS;
    const download = await this.waitForDownloadChange(
      (change) =>
        change.id === params.downloadId &&
        (change.status === "complete" || change.status === "failed" || change.status === "canceled"),
      timeoutMs,
      `Timed out waiting for download ${params.downloadId}.`
    );
    return { path: download.status === "complete" ? download.filename ?? null : null };
  }

  async readClipboardText(params) {
    await this.requireSessionTab(params, "readClipboardText");
    const tabId = requireTabId(params, "readClipboardText");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const text = await this.evaluateJavascript(tabId, "navigator.clipboard.readText()", true);
    return { text: typeof text === "string" ? text : "" };
  }

  async writeClipboardText(params) {
    await this.requireSessionTab(params, "writeClipboardText");
    const tabId = requireTabId(params, "writeClipboardText");
    if (typeof params.text !== "string") {
      throw new Error("writeClipboardText requires text");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(tabId, `navigator.clipboard.writeText(${JSON.stringify(params.text)})`, true);
  }

  async readClipboard(params) {
    await this.requireSessionTab(params, "readClipboard");
    const tabId = requireTabId(params, "readClipboard");
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    const items = await this.evaluateJavascript(
      tabId,
      `((async () => {
        const clipboardItems = await navigator.clipboard.read();
        return await Promise.all(clipboardItems.map(async (item) => {
          const entries = await Promise.all(item.types.map(async (type) => {
            const blob = await item.getType(type);
            if (type.startsWith("text/")) {
              return { mime_type: type, text: await blob.text() };
            }
            const base64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onerror = () => reject(reader.error);
              reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
              reader.readAsDataURL(blob);
            });
            return { mime_type: type, base64 };
          }));
          return { entries, presentation_style: item.presentationStyle ?? "unspecified" };
        }));
      })())`,
      true
    );
    return { items: Array.isArray(items) ? items : [] };
  }

  async writeClipboard(params) {
    await this.requireSessionTab(params, "writeClipboard");
    const tabId = requireTabId(params, "writeClipboard");
    if (!Array.isArray(params.items)) {
      throw new Error("writeClipboard requires items");
    }
    if (!this.attachedTabs.has(tabId)) {
      await this.attach(params);
    }
    await this.evaluateJavascript(
      tabId,
      `((async (items) => {
        const clipboardItems = items.map((item) => {
          const entries = {};
          for (const entry of item.entries ?? []) {
            const mime = entry.mime_type;
            if (!mime) continue;
            if (entry.text !== undefined) {
              entries[mime] = new Blob([entry.text], { type: mime });
            } else if (entry.base64 !== undefined) {
              const binary = atob(entry.base64);
              const bytes = new Uint8Array(binary.length);
              for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
              }
              entries[mime] = new Blob([bytes], { type: mime });
            }
          }
          return new ClipboardItem(entries, { presentationStyle: item.presentation_style ?? "unspecified" });
        });
        await navigator.clipboard.write(clipboardItems);
      })(${JSON.stringify(params.items)}))`,
      true
    );
  }

  async turnEnded(params) {
    const session = await this.requireSession(params);
    const tabs = await this.getSessionTabs(session.sessionId);
    await this.detachMany(tabs.filter(hasTabId).map((tab) => tab.id));
    this.activeTabsBySession.delete(session.sessionId);
    for (const tab of tabs) {
      if (hasTabId(tab)) {
        this.cursorByTabId.delete(tab.id);
      }
    }
    const sessionState = await this.store.getSession(session.sessionId);
    sessionState.activeTabId = null;
    await this.store.save();
    await Promise.allSettled(tabs.filter(hasTabId).map((tab) => this.publishCursorState(tab.id)));
  }

  async executeUnhandledCommand(params) {
    throw new Error(`Open Browser Use Chrome does not support command "${params.type}"`);
  }

  addDownloadChangeListener(listener) {
    this.downloadChangeListeners.add(listener);
    return () => this.downloadChangeListeners.delete(listener);
  }

  recordDownloadBegin(tabId, params) {
    const now = Date.now();
    this.recentDownloadBegins = this.recentDownloadBegins.filter(
      (entry) => now - entry.at < DOWNLOAD_CORRELATION_WINDOW_MS
    );
    this.recentDownloadBegins.push({
      tabId,
      url: typeof params.url === "string" ? params.url : "",
      guid: typeof params.guid === "string" ? params.guid : undefined,
      suggestedFilename: typeof params.suggestedFilename === "string" ? params.suggestedFilename : undefined,
      at: now
    });
  }

  // Best guess of the tab that started a chrome.downloads item: a recent
  // Page.downloadWillBegin with the same URL, else a session tab whose URL is
  // the referrer, else the only active session tab. Confidence is reported.
  async guessDownloadTab(item, urls) {
    const now = Date.now();
    const begin = [...this.recentDownloadBegins]
      .reverse()
      .find((entry) => now - entry.at < DOWNLOAD_CORRELATION_WINDOW_MS && urls.includes(entry.url));
    if (begin) {
      this.recentDownloadBegins = this.recentDownloadBegins.filter((entry) => entry !== begin);
      return { tabId: begin.tabId, guid: begin.guid, confidence: "cdp" };
    }
    const referrer = typeof item.referrer === "string" ? item.referrer : "";
    const activeTabIds = [...this.activeTabsBySession.values()];
    if (referrer) {
      for (const tabId of activeTabIds) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.url && tab.url === referrer) {
          return { tabId, confidence: "referrer" };
        }
      }
    }
    if (activeTabIds.length === 1) {
      return { tabId: activeTabIds[0], confidence: "only_active" };
    }
    return null;
  }

  async handleDownloadCreated(item) {
    if (!Number.isInteger(item?.id)) {
      return;
    }
    const filename = typeof item.filename === "string" ? item.filename : "";
    const url =
      typeof item.finalUrl === "string" && item.finalUrl ? item.finalUrl : typeof item.url === "string" ? item.url : "";
    const urls = [item.url, item.finalUrl].filter((value) => typeof value === "string" && value);
    const guess = this.isBrowserControlActive() || this.recentDownloadBegins.length > 0
      ? await this.guessDownloadTab(item, urls)
      : null;
    if (!this.isBrowserControlActive() && !guess) {
      return;
    }
    const owner = guess ? await this.store.findTabOwner(guess.tabId) : null;
    const context = {
      ...(typeof item.referrer === "string" && item.referrer ? { referrer: item.referrer } : {}),
      ...(typeof item.startTime === "string" ? { startTime: item.startTime } : {}),
      ...(typeof item.mime === "string" && item.mime ? { mime: item.mime } : {}),
      ...(Number.isFinite(item.totalBytes) && item.totalBytes >= 0 ? { totalBytes: item.totalBytes } : {}),
      ...(guess ? { tabId: guess.tabId, tabConfidence: guess.confidence } : {}),
      ...(guess?.guid ? { guid: guess.guid } : {}),
      ...(owner ? { sessionId: owner.sessionId } : {})
    };
    this.downloadFilenamesById.set(item.id, filename);
    this.downloadUrlsById.set(item.id, url);
    this.downloadContextById.set(item.id, context);
    this.emitDownloadChange({
      id: String(item.id),
      filename,
      url,
      status: "started",
      ...context
    });
  }

  handleDownloadChanged(delta) {
    if (!Number.isInteger(delta?.id)) {
      return;
    }
    const filename =
      typeof delta.filename?.current === "string"
        ? delta.filename.current
        : this.downloadFilenamesById.get(delta.id);
    const url = this.downloadUrlsById.get(delta.id);
    if (typeof filename !== "string" || typeof url !== "string") {
      return;
    }
    this.downloadFilenamesById.set(delta.id, filename);
    const status = downloadStatus(delta);
    if (!status) {
      return;
    }
    this.emitDownloadChange({
      id: String(delta.id),
      filename,
      url,
      status,
      ...(this.downloadContextById.get(delta.id) ?? {})
    });
    if (status === "complete" || status === "failed" || status === "canceled") {
      this.downloadFilenamesById.delete(delta.id);
      this.downloadUrlsById.delete(delta.id);
      this.downloadContextById.delete(delta.id);
    }
  }

  notifyCursorArrived(params) {
    const moveSequence = params?.moveSequence;
    if (!Number.isInteger(moveSequence)) {
      return false;
    }
    const waiter = this.cursorArrivalWaitersByKey.get(cursorArrivalKey(params.sessionId, params.turnId, moveSequence));
    waiter?.();
    return Boolean(waiter);
  }

  // --- Chrome tab events → lease / popup notifications -------------------

  // A tab opened by one of a session's tabs (window.open, target=_blank,
  // middle-click) is adopted by that session and reported as popupOpened.
  // Attribution, most to least certain: the opener tab is owned; the new tab
  // landed in an agent group (Chrome puts link-opened tabs in the source
  // tab's group); an agent acted on a tab in the last 2 s (Chrome may report
  // the window's active tab as opener for background-tab popups).
  async attributePopup(tab) {
    if (Number.isInteger(tab.openerTabId)) {
      const owner = await this.store.findTabOwner(tab.openerTabId);
      if (owner) return { sessionId: owner.sessionId, openerTabId: tab.openerTabId };
    }
    const recent = this.lastAgentAction && Date.now() - this.lastAgentAction.at < 2_000 ? this.lastAgentAction : null;
    if (typeof tab.groupId === "number" && tab.groupId !== -1) {
      const owner = await this.store.findSessionByGroup(tab.groupId);
      if (owner) {
        if (recent) {
          const { rootSessionId } = await this.store.getRoot(recent.sessionId);
          if (rootSessionId === owner.sessionId) return { sessionId: recent.sessionId, openerTabId: recent.tabId };
        }
        return { sessionId: owner.sessionId, openerTabId: tab.openerTabId ?? null };
      }
    }
    if (recent && Number.isInteger(tab.openerTabId) && !(await this.store.findTabOwner(tab.openerTabId))) {
      return { sessionId: recent.sessionId, openerTabId: recent.tabId };
    }
    return null;
  }

  async handleTabCreated(tab) {
    if (!hasTabId(tab) || (await this.store.findTabOwner(tab.id))) {
      return;
    }
    if (!Number.isInteger(tab.openerTabId) && (tab.groupId ?? -1) === -1) {
      return;
    }
    const attribution = await this.attributePopup(tab);
    if (!attribution || (await this.store.findTabOwner(tab.id))) {
      return;
    }
    await this.ensureSessionGroup(attribution.sessionId, tab.id, "agent").catch(() => {});
    if (tab.active) {
      await this.restoreUserFocus(tab).catch(() => {});
    }
    this.emit("popupOpened", {
      tabId: tab.id,
      openerTabId: attribution.openerTabId,
      sessionId: attribution.sessionId,
      ...(tab.pendingUrl || tab.url ? { url: tab.pendingUrl || tab.url } : {})
    });
  }

  handleTabActivated({ tabId, windowId }) {
    const history = (this.activationHistory.get(windowId) ?? []).filter((id) => id !== tabId);
    history.push(tabId);
    this.activationHistory.set(windowId, history.slice(-8));
  }

  // An agent-opened tab came up in the foreground: give the window back to the
  // tab the user had active before it.
  async restoreUserFocus(tab) {
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (win?.type && win.type !== "normal") {
      return null; // popup/app windows: the agent's own window, leave it
    }
    const isUserTab = async (tabId) => tabId !== tab.id && !(await this.store.findTabOwner(tabId));
    const history = this.activationHistory.get(tab.windowId) ?? [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const candidate = history[i];
      if (!(await isUserTab(candidate))) continue;
      const previous = await chrome.tabs.get(candidate).catch(() => null);
      if (!previous) continue;
      await chrome.tabs.update(candidate, { active: true });
      return candidate;
    }
    // No activation seen yet (service worker started after the user's last
    // switch): fall back to the user's most recently accessed tab there.
    const inWindow = (await chrome.tabs.query({ windowId: tab.windowId }).catch(() => []))
      .filter((other) => hasTabId(other) && other.windowId === tab.windowId)
      .sort(compareLastAccessed);
    for (const other of inWindow) {
      if (!(await isUserTab(other.id))) continue;
      await chrome.tabs.update(other.id, { active: true });
      return other.id;
    }
    return null;
  }

  // Dragging an owned tab out of the agent group (or into another window)
  // hands it to the user: ownership is dropped and the daemon gets leaseRevoked.
  async handleTabUpdated(tabId, changeInfo, tab) {
    if (!changeInfo || !Object.hasOwn(changeInfo, "groupId")) {
      return;
    }
    // Our own group mutations are queued; let them land (root.chromeGroupId is
    // assigned after chrome.tabs.group resolves) before judging the change.
    await this.groupQueue;
    const owner = await this.store.findTabOwner(tabId);
    if (!owner || owner.origin === "popup") {
      return;
    }
    const { root } = await this.store.getRoot(owner.sessionId);
    const current = await chrome.tabs.get(tabId).catch(() => null);
    const groupId = current ? current.groupId : changeInfo.groupId;
    if (typeof root.chromeGroupId === "number" && groupId === root.chromeGroupId) {
      return;
    }
    // A group can be emptied and re-created by Chrome when the last tab moves
    // windows; treat any other group (or none) as the user taking the tab.
    delete owner.session.tabOrigins[String(tabId)];
    this.dropTabState(owner.sessionId, tabId);
    await this.store.save();
    this.emit("leaseRevoked", {
      tabId,
      sessionId: owner.sessionId,
      reason: "group_exit",
      groupId,
      ...(tab?.url ? { url: tab.url } : {})
    });
  }

  async handleTabRemoved(tabId) {
    this.attachedTabs.delete(tabId);
    const owner = await this.store.findTabOwner(tabId);
    if (!owner) {
      return;
    }
    delete owner.session.tabOrigins[String(tabId)];
    this.dropTabState(owner.sessionId, tabId);
    await this.store.save();
    this.emit("tabClosed", { tabId, sessionId: owner.sessionId });
  }

  // Event fan-out for chrome.debugger.onEvent. Returns the notification params
  // to send, or null to drop the event.
  routeCdpEvent(source, method, params) {
    this.handleCdpEvent(source, method, params);
    const subscribers = this.cdpEventSubscribers(source, method);
    if (subscribers !== null && subscribers.length === 0) {
      return null;
    }
    return {
      source,
      method,
      params,
      ...(typeof source?.sessionId === "string" ? { sessionId: source.sessionId } : {}),
      ...(subscribers ? { subscribers } : {})
    };
  }

  handleCdpEvent(source, method, params) {
    if (
      (method === "Page.downloadWillBegin" || method === "Browser.downloadWillBegin") &&
      typeof source?.tabId === "number"
    ) {
      this.recordDownloadBegin(source.tabId, params ?? {});
      return;
    }
    if (method !== "Page.fileChooserOpened" || typeof source?.tabId !== "number") {
      return;
    }
    const waiter = this.fileChooserWaitersByTabId.get(source.tabId);
    waiter?.resolve(params ?? {});
  }

  waitForFileChooserEvent(tabId) {
    if (this.fileChooserWaitersByTabId.has(tabId)) {
      throw new Error(`Already waiting for file chooser in tab ${tabId}`);
    }
    return new Promise((resolve, reject) => {
      this.fileChooserWaitersByTabId.set(tabId, {
        resolve: (event) => {
          this.fileChooserWaitersByTabId.delete(tabId);
          if (!Number.isInteger(event.backendNodeId)) {
            reject(new Error("File chooser event did not include backendNodeId"));
            return;
          }
          const fileChooserId = crypto.randomUUID();
          const chooser = {
            tabId,
            backendNodeId: event.backendNodeId,
            isMultiple: event.mode === "selectMultiple"
          };
          this.fileChoosersById.set(fileChooserId, chooser);
          resolve({
            fileChooserId,
            isMultiple: chooser.isMultiple
          });
        }
      });
    });
  }

  readCursorOverlayState(tabId) {
    for (const [sessionId, activeTabId] of this.activeTabsBySession) {
      if (activeTabId === tabId) {
        return {
          cursor: this.cursorByTabId.get(tabId) ?? null,
          isVisible: true,
          sessionId,
          turnId: null
        };
      }
    }
    return {
      cursor: null,
      isVisible: false,
      sessionId: null,
      turnId: null
    };
  }

  isBrowserControlActive() {
    return this.activeTabsBySession.size > 0;
  }

  createCursorArrivalWaiter(sessionId, turnId, moveSequence) {
    const key = cursorArrivalKey(sessionId, turnId, moveSequence);
    let timeoutId;
    let resolvePromise;
    const resolve = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      this.cursorArrivalWaitersByKey.delete(key);
      resolvePromise?.();
    };
    const promise = new Promise((resolveInner) => {
      resolvePromise = resolveInner;
      timeoutId = setTimeout(resolve, CURSOR_ARRIVAL_TIMEOUT_MS);
      this.cursorArrivalWaitersByKey.set(key, resolve);
    });
    return { promise, cancel: resolve };
  }

  emitDownloadChange(change) {
    this.downloadsById.set(change.id, {
      ...(this.downloadsById.get(change.id) ?? {}),
      ...change
    });
    for (const waiter of [...this.downloadWaiters]) {
      if (waiter.predicate(change)) {
        waiter.resolve(change);
      }
    }
    for (const listener of this.downloadChangeListeners) {
      listener(change);
    }
  }

  waitForDownloadChange(predicate, timeoutMs, timeoutMessage) {
    for (const change of this.downloadsById.values()) {
      if (predicate(change)) {
        return Promise.resolve(change);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (change) => {
          cleanup();
          resolve(change);
        }
      };
      const cleanup = () => {
        clearTimeout(timeoutId);
        this.downloadWaiters.delete(waiter);
      };
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.downloadWaiters.add(waiter);
    });
  }

  async evaluateJavascript(tabId, expression, awaitPromise) {
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "JavaScript evaluation failed");
    }
    return result.result?.value;
  }

  // One group per ROOT session (subagents share it); ownership stays per
  // session in tabOrigins. Tabs that cannot be grouped (popup windows) are
  // owned with origin "popup".
  async ensureSessionGroup(sessionId, tabId, origin) {
    const session = await this.store.getSession(sessionId);
    const { root } = await this.store.getRoot(sessionId);
    session.tabOrigins[String(tabId)] = origin;
    await this.store.save();
    await this.queueGroupOp(async () => {
      let groupId = root.chromeGroupId;
      let created = false;
      if (typeof groupId === "number") {
        try {
          await chrome.tabGroups.get(groupId);
          await chrome.tabs.group({ groupId, tabIds: [tabId] });
        } catch {
          groupId = null;
        }
      }
      if (typeof groupId !== "number") {
        try {
          groupId = await chrome.tabs.group({ tabIds: [tabId] });
        } catch (error) {
          if (origin === "agent" || origin === "popup") {
            session.tabOrigins[String(tabId)] = "popup";
            await this.store.save();
            return;
          }
          throw error;
        }
        root.chromeGroupId = groupId;
        created = true;
        await this.store.save();
      }
      if (created) {
        await chrome.tabGroups.update(groupId, {
          title: root.title,
          color: BRAND.groupColor,
          collapsed: false
        });
      }
    });
  }

  async setSessionActiveTab(sessionId, tabId) {
    const session = await this.store.getSession(sessionId);
    session.activeTabId = tabId;
    this.activeTabsBySession.set(sessionId, tabId);
    await this.store.save();
    // Fire-and-forget: injecting the cursor overlay waits for the page to be
    // scriptable (a loading background tab can take seconds); never block the
    // agent's call on decoration.
    void this.publishCursorState(tabId).catch(() => false);
  }

  // A session's tabs: its owned tabs still in the root group (plus popup-window
  // tabs it adopted). The root also sees un-owned tabs a user dropped into its
  // group (legacy behaviour); children never see siblings' or parent's tabs.
  async getSessionTabs(sessionId) {
    const session = await this.store.getSession(sessionId);
    const { rootSessionId, root } = await this.store.getRoot(sessionId);
    const origins = session.tabOrigins ?? {};
    const tabs = [];
    if (typeof root.chromeGroupId === "number") {
      let grouped;
      try {
        grouped = await chrome.tabs.query({ groupId: root.chromeGroupId });
      } catch {
        grouped = null;
      }
      if (grouped === null) {
        if (rootSessionId === sessionId) {
          await this.store.removeSession(sessionId);
        }
        return [];
      }
      for (const tab of grouped) {
        if (!hasTabId(tab) || tab.url?.startsWith("chrome://")) continue;
        if (Object.hasOwn(origins, String(tab.id))) {
          tabs.push(tab);
        } else if (rootSessionId === sessionId && !(await this.store.findTabOwner(tab.id))) {
          tabs.push(tab);
        }
      }
    }
    for (const [tabIdText, origin] of Object.entries(origins)) {
      if (origin !== "popup") continue;
      const tab = await chrome.tabs.get(Number(tabIdText)).catch(() => null);
      if (hasTabId(tab) && !tabs.some((existing) => existing.id === tab.id)) {
        tabs.push(tab);
      }
    }
    return tabs;
  }

  async requireSession(params) {
    if (!params || typeof params !== "object") {
      throw new Error("Missing browser session params");
    }
    if (typeof params.session_id !== "string") {
      throw new Error("Missing required browser session_id");
    }
    if (typeof params.turn_id !== "string") {
      throw new Error("Missing required browser turn_id");
    }
    const sessionState = await this.store.getSession(params.session_id, {
      parentSessionId: typeof params.parent_session_id === "string" ? params.parent_session_id : undefined,
      label: typeof params.label === "string" ? params.label : undefined
    });
    // In-memory only (no storage write per call); persisted by other saves.
    sessionState.lastSeenAt = Date.now();
    return { sessionId: params.session_id, turnId: params.turn_id };
  }

  // Finalizes sessions idle past the lease: agent tabs close (close guard
  // still applies), handoff tabs stay with the user, borrowed tabs are released.
  async sweepExpiredSessions(now = Date.now()) {
    if (this.sessionLeaseMs <= 0) {
      return [];
    }
    await this.store.ready;
    const expired = [];
    for (const [sessionId, session] of Object.entries(this.store.state.sessions)) {
      if (!session || typeof session !== "object") continue;
      const lastSeenAt = typeof session.lastSeenAt === "number" ? session.lastSeenAt : 0;
      if (now - lastSeenAt < this.sessionLeaseMs) continue;
      const handoff = Array.isArray(session.handoffTabIds) ? session.handoffTabIds : [];
      const ownedOrigins = Object.keys(session.tabOrigins ?? {}).filter((id) => !handoff.includes(Number(id)));
      if (ownedOrigins.length === 0) continue;
      expired.push(sessionId);
    }
    const results = [];
    for (const sessionId of expired) {
      const session = this.store.state.sessions[sessionId];
      const tabs = await this.getSessionTabs(sessionId).catch(() => []);
      const handoff = new Set(Array.isArray(session?.handoffTabIds) ? session.handoffTabIds : []);
      const keep = tabs.filter((tab) => handoff.has(tab.id)).map((tab) => ({ tabId: tab.id, status: "handoff" }));
      try {
        const result = await this.finalizeTabs({ session_id: sessionId, turn_id: "lease-expired", keep });
        this.emit("sessionExpired", { sessionId, ...result });
        results.push({ sessionId, ...result });
      } catch {}
    }
    return results;
  }

  async requireSessionTab(params, command) {
    const session = await this.requireSession(params);
    const tabId = requireTabId(params, command);
    const tabs = await this.getSessionTabs(session.sessionId);
    if (!tabs.some((tab) => tab.id === tabId)) {
      throw new Error(`Tab ${tabId} is not part of browser session ${session.sessionId}`);
    }
  }

  async withLogicalActive(sessionId, tabs) {
    if (tabs.length === 0) {
      return tabs;
    }
    const session = await this.store.getSession(sessionId);
    let activeTabId = this.activeTabsBySession.get(sessionId) ?? session.activeTabId;
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      activeTabId = tabs.find((tab) => tab.active)?.id ?? tabs[0].id;
      await this.setSessionActiveTab(sessionId, activeTabId);
    } else if (!this.activeTabsBySession.has(sessionId)) {
      this.activeTabsBySession.set(sessionId, activeTabId);
    }
    return tabs.map((tab) => ({ ...tab, active: tab.id === activeTabId }));
  }

  async moveToDeliverables(tabIds) {
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
      return;
    }

    const tabRecords = await Promise.all(
      tabIds.map((id) => chrome.tabs.get(id).catch(() => null))
    );
    const tabsByWindow = new Map();
    for (const tab of tabRecords) {
      if (!tab || typeof tab.id !== "number" || typeof tab.windowId !== "number") continue;
      const arr = tabsByWindow.get(tab.windowId) ?? [];
      arr.push(tab.id);
      tabsByWindow.set(tab.windowId, arr);
    }
    if (tabsByWindow.size === 0) {
      return;
    }

    const storedGroupId = this.store.state.deliverableGroupId;
    let lastGroupId = null;

    for (const [windowId, windowTabIds] of tabsByWindow) {
      // Agent groups may share the deliverable title (brand mark only), so
      // never merge into a group a live session owns.
      const sessionGroupIds = new Set(
        Object.values(this.store.state.sessions)
          .map((session) => session?.chromeGroupId)
          .filter((groupId) => typeof groupId === "number")
      );
      const titled = await Promise.all(
        [DELIVERABLE_GROUP_TITLE, ...LEGACY_DELIVERABLE_GROUP_TITLES].map((title) =>
          chrome.tabGroups.query({ windowId, title }).catch(() => [])
        )
      );
      const existingGroups = titled
        .flat()
        .filter((group, index, all) => !sessionGroupIds.has(group.id) && all.findIndex((other) => other.id === group.id) === index);

      let primaryGroupId = null;
      if (existingGroups.length > 0) {
        const preferred =
          existingGroups.find((g) => g.id === storedGroupId) ??
          existingGroups.reduce((min, g) => (g.id < min.id ? g : min), existingGroups[0]);
        primaryGroupId = preferred.id;

        for (const group of existingGroups) {
          if (group.id === primaryGroupId) continue;
          const dupTabs = await chrome.tabs.query({ groupId: group.id }).catch(() => []);
          const dupTabIds = dupTabs
            .map((t) => t.id)
            .filter((id) => typeof id === "number");
          if (dupTabIds.length > 0) {
            await chrome.tabs
              .group({ groupId: primaryGroupId, tabIds: dupTabIds })
              .catch(() => {});
          }
        }
      }

      if (typeof primaryGroupId === "number") {
        try {
          await chrome.tabs.group({ groupId: primaryGroupId, tabIds: windowTabIds });
        } catch {
          primaryGroupId = null;
        }
      }

      if (typeof primaryGroupId !== "number") {
        primaryGroupId = await chrome.tabs.group({ tabIds: windowTabIds });
      }

      await chrome.tabGroups
        .update(primaryGroupId, {
          title: DELIVERABLE_GROUP_TITLE,
          color: BRAND.deliverableGroupColor,
          collapsed: false
        })
        .catch(() => {});

      lastGroupId = primaryGroupId;
    }

    if (typeof lastGroupId === "number") {
      this.store.state.deliverableGroupId = lastGroupId;
      await this.store.save();
    }
  }

  async detachMany(tabIds) {
    await Promise.allSettled(tabIds.map((tabId) => this.detachTab(tabId)));
  }

  async detachTab(tabId) {
    this.clearIdleTimer(tabId);
    try {
      await chrome.debugger.detach({ tabId });
    } finally {
      this.attachedTabs.delete(tabId);
      for (const [fileChooserId, chooser] of this.fileChoosersById) {
        if (chooser.tabId === tabId) {
          this.fileChoosersById.delete(fileChooserId);
        }
      }
      this.cursorByTabId.delete(tabId);
    }
  }

  async ensureCursorContentScript(sessionId, tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "OPEN_BROWSER_USE_PING" });
      if (response?.ok) {
        return true;
      }
    } catch {}
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-cursor.js"]
      });
      return true;
    } catch {
      return false;
    }
  }

  async requireWebMcpEnabled() {
    if ((await this.webMcpGate?.enabled?.()) !== true) {
      throw new Error("WebMCP capability is disabled");
    }
  }

  async sendWebMcpRequest(tabId, request, timeoutMs) {
    await this.ensureWebMcpContentScripts(tabId);
    const response = await withWebMcpTimeout(timeoutMs, async () => {
      return await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_REQUEST",
        ...request
      });
    });
    if (response?.ok !== true) {
      throw new Error(
        typeof response?.error === "string" ? response.error : "WebMCP page bridge request failed"
      );
    }
    return response.result;
  }

  async ensureWebMcpContentScripts(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_PING"
      });
      if (response?.ok === true) {
        return;
      }
    } catch {}

    try {
      await chrome.scripting.executeScript({
        files: ["content-webmcp-main.js"],
        target: { tabId },
        world: "MAIN"
      });
      await chrome.scripting.executeScript({
        files: ["content-webmcp-bridge.js"],
        target: { tabId },
        world: "ISOLATED"
      });
    } catch (error) {
      throw new Error(
        `Cannot inject WebMCP bridge into tab ${tabId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_WEBMCP_PING"
      });
      if (response?.ok === true) {
        return;
      }
    } catch {}
    throw new Error(`WebMCP bridge is unavailable in tab ${tabId}`);
  }

  async publishCursorState(tabId) {
    if (!(await this.ensureCursorContentScript(null, tabId))) {
      return false;
    }
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "OPEN_BROWSER_USE_CURSOR_STATE",
        state: this.readCursorOverlayState(tabId)
      });
      return response?.ok === true;
    } catch {
      return false;
    }
  }
}

function hasTabId(tab) {
  return typeof tab?.id === "number";
}

function toBrowserTab(tab) {
  return {
    id: tab.id,
    title: tab.title,
    active: tab.active,
    url: tab.url
  };
}

function toUserTab(tab, groupTitles) {
  const lastAccessed =
    typeof tab.lastAccessed === "number" && Number.isFinite(tab.lastAccessed)
      ? new Date(tab.lastAccessed).toISOString()
      : undefined;
  const groupTitle =
    typeof tab.groupId === "number" && tab.groupId !== -1 ? groupTitles.get(tab.groupId) : undefined;
  return {
    id: tab.id,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(lastAccessed ? { lastOpened: lastAccessed } : {}),
    ...(groupTitle ? { tabGroup: groupTitle } : {})
  };
}

function requireTabId(params, command) {
  if (!Number.isInteger(params.tabId)) {
    throw new Error(`${command} requires an integer tabId`);
  }
  return params.tabId;
}

function requireWebMcpTabId(params, command) {
  const candidate = params?.tabId ?? params?.tab_id;
  if (Number.isInteger(candidate) && candidate >= 0) {
    return candidate;
  }
  if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  throw new Error(`${command} requires integer tabId`);
}

function requireNonEmptyString(value, message) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

function optionalPositiveInteger(value, fallback, field) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

// Opens a background tab in the session's bound window, never activating it or
// focusing its window. The window is bound on first use: last-focused normal
// window → the only normal window → the focused one.
async function createBackgroundTab(rootState = null, url = "about:blank") {
  let windowId = rootState?.windowId;
  if (typeof windowId === "number") {
    const bound = await chrome.windows.get(windowId).catch(() => null);
    if (!bound || (bound.type && bound.type !== "normal")) {
      windowId = null;
    }
  }
  if (typeof windowId !== "number") {
    windowId = await chooseWindowId();
  }
  if (typeof windowId === "number") {
    const tab = await chrome.tabs.create({ active: false, url, windowId });
    if (hasTabId(tab)) {
      if (rootState) rootState.windowId = windowId;
      return tab;
    }
  }
  const win = await chrome.windows.create({
    focused: false,
    type: "normal",
    url
  });
  if (rootState && typeof win.id === "number") rootState.windowId = win.id;
  const tab = win.tabs?.find(hasTabId);
  if (!tab) {
    throw new Error("Created Chrome window has no tab");
  }
  return tab;
}

async function chooseWindowId() {
  const lastFocused = await chrome.windows.getLastFocused?.({ windowTypes: ["normal"] }).catch(() => null);
  if (typeof lastFocused?.id === "number" && (!lastFocused.type || lastFocused.type === "normal")) {
    return lastFocused.id;
  }
  const windows = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter(
    (win) => typeof win.id === "number"
  );
  if (windows.length === 1) {
    return windows[0].id;
  }
  const focused = windows.find((win) => win.focused);
  return focused?.id ?? windows[0]?.id ?? null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readGroupTitles(tabs) {
  const ids = new Set(
    tabs
      .map((tab) => tab.groupId)
      .filter((groupId) => typeof groupId === "number" && groupId !== -1)
  );
  const entries = await Promise.all(
    [...ids].map(async (groupId) => {
      try {
        const group = await chrome.tabGroups.get(groupId);
        return group.title ? [groupId, group.title] : null;
      } catch {
        return null;
      }
    })
  );
  return new Map(entries.filter(Boolean));
}

function compareLastAccessed(left, right) {
  const byLastAccessed = (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0);
  if (byLastAccessed !== 0) {
    return byLastAccessed;
  }
  const byWindow = (left.windowId ?? 0) - (right.windowId ?? 0);
  return byWindow !== 0 ? byWindow : (left.index ?? 0) - (right.index ?? 0);
}

function parseDate(value, field) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new Error(`getUserHistory requires ${field} to be a valid date`);
  }
  return timestamp;
}

function downloadStatus(delta) {
  switch (delta.state?.current) {
    case "complete":
      return "complete";
    case "interrupted":
      return delta.error?.current === "USER_CANCELED" ? "canceled" : "failed";
    case "in_progress":
      return "in_progress";
    default:
      return undefined;
  }
}

function cursorArrivalKey(sessionId, turnId, moveSequence) {
  return `${sessionId}:${turnId}:${moveSequence}`;
}

async function withTimeout(timeoutMs, fn) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP command.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function withWebMcpTimeout(timeoutMs, fn) {
  let timeout;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for WebMCP page bridge.`));
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function startHeartbeat(peer, backend) {
  chrome.alarms.create(HEARTBEAT_ALARM_NAME, { periodInMinutes: 0.5 }).catch(() => {});
  chrome.alarms.create(LEASE_SWEEP_ALARM_NAME, { periodInMinutes: 0.5 }).catch(() => {});
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === LEASE_SWEEP_ALARM_NAME) {
      void backend.sweepExpiredSessions().catch(() => {});
    }
    if (alarm.name === HEARTBEAT_ALARM_NAME) {
      safeSendNotification(peer, "heartbeat", { at: new Date().toISOString() });
      void backend.getInfo().catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { extensionInstanceId } = await chrome.storage.local.get("extensionInstanceId");
  if (typeof extensionInstanceId !== "string") {
    await chrome.storage.local.set({ extensionInstanceId: crypto.randomUUID() });
  }
});

const webMcpGate = new WebMcpGate();
const backend = new BrowserBackend({ webMcpGate });
const transport = new NativeTransport(NATIVE_HOST_NAME);
const peer = new JsonRpcPeer(transport, backend);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "GET_NATIVE_HOST_STATUS") {
    const status = transport.getStatus();
    sendResponse({ ok: status.state === "connected", status, error: status.error });
    return true;
  }
  if (message?.type === "GET_OPEN_BROWSER_USE_CURSOR_STATE") {
    const tabId = typeof sender.tab?.id === "number" ? sender.tab.id : -1;
    sendResponse({ ok: true, state: backend.readCursorOverlayState(tabId) });
    return true;
  }
  if (message?.type === "OPEN_BROWSER_USE_CURSOR_ARRIVED") {
    sendResponse({ ok: backend.notifyCursorArrived(message) });
    return true;
  }
  return false;
});
backend.notify = (method, params) => safeSendNotification(peer, method, params);
chrome.debugger.onEvent.addListener((source, method, params) => {
  const routed = backend.routeCdpEvent(source, method, params);
  if (routed) {
    safeSendNotification(peer, "onCDPEvent", routed);
  }
});
chrome.tabs.onCreated?.addListener((tab) => {
  void backend.handleTabCreated(tab).catch(() => {});
});
chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
  void backend.handleTabUpdated(tabId, changeInfo, tab).catch(() => {});
});
chrome.tabs.onActivated?.addListener((activeInfo) => {
  backend.handleTabActivated(activeInfo);
});
// Seed per-window activation history with the tabs active right now, so the
// first agent popup after a service-worker start can hand focus back.
void chrome.tabs.query?.({ active: true })
  ?.then((tabs) => {
    for (const tab of tabs) {
      if (hasTabId(tab) && !backend.activationHistory.get(tab.windowId)?.length) {
        backend.handleTabActivated({ tabId: tab.id, windowId: tab.windowId });
      }
    }
  })
  .catch(() => {});
chrome.tabs.onRemoved?.addListener((tabId) => {
  void backend.handleTabRemoved(tabId).catch(() => {});
});
backend.addDownloadChangeListener((change) => {
  safeSendNotification(peer, "onDownloadChange", change);
});
chrome.downloads.onCreated.addListener((item) => {
  void backend.handleDownloadCreated(item).catch(() => {});
});
chrome.downloads.onChanged.addListener((delta) => {
  backend.handleDownloadChanged(delta);
});
startHeartbeat(peer, backend);

function safeSendNotification(peer, method, params) {
  try {
    peer.sendNotification(method, params);
  } catch {}
}
