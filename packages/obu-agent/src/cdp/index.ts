// WS-C: CDP session manager over the native host socket.
// Attach once per tab (cache), A3 attach sequence minus Runtime.enable (I8),
// owned-tab 1440x900 metrics override (I6), auto-attach OOPIFs (flatten),
// inject the WS-D bundle into UTILITY_WORLD_NAME, health-check + re-inject
// (10 tries x 200 ms), focus emulation only during a call (I7).
export type { FrameHandle, PageContext, TabCdp } from "../seams.js";

/** CDP methods sent on attach, in order (documentation + tests assert Runtime.enable is absent). */
export const ATTACH_SEQUENCE = [
  "Page.enable",
  "DOM.enable",
  "Network.enable",
  "Inspector.enable",
  "Page.setWebLifecycleState",
  "Target.setAutoAttach",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
] as const;

export const FORBIDDEN_ON_AGENT_PAGES = ["Runtime.enable", "Debugger.enable"] as const;
