// WS-C: CDP session manager over the native host socket (or a direct
// --remote-debugging-port connection for tests / fast mode).
// Attach once per tab (cache), A3 attach sequence minus Runtime.enable (I8),
// owned-tab 1440x900 metrics override (I6), auto-attach OOPIFs (flatten),
// inject the WS-D bundle into UTILITY_WORLD_NAME, health-check + re-inject
// (10 tries x 200 ms), focus emulation only during a call (I7).
export type { FrameHandle, PageContext, TabCdp } from "../seams.js";
export { type BrowserBackend, type BackendEvent, type BackendOwner, type BackendTab, isTabGoneError, isContextGoneError } from "./backend.js";
export { DirectCdpBackend, type DirectCdpOptions } from "./direct.js";
export { ObuHostBackend, resolveObuSocket, resolveRelay, type ObuHostOptions } from "./obu-host.js";
export { TabRuntime, type TabRuntimeOptions, type DialogDecision } from "./page.js";

/** CDP methods sent on attach, in order (documentation + tests assert Runtime.enable is absent). */
export const ATTACH_SEQUENCE = [
  "Page.enable",
  "DOM.enable",
  "Network.enable",
  "Inspector.enable",
  "Page.setWebLifecycleState",
  "Emulation.setDeviceMetricsOverride",
  "Target.setAutoAttach",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
] as const;

export const FORBIDDEN_ON_AGENT_PAGES = ["Runtime.enable", "Debugger.enable"] as const;
