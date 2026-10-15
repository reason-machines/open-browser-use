// WS-C: MCP stdio proxy (`obu-agent mcp --attach`) with STATIC tool schemas
// derived from contract.ts (no runtime discovery).
import type { MethodName } from "../contract.js";

/** MCP tool name -> daemon method. Tool schemas are generated from contract types by WS-C. */
export const MCP_TOOLS: Record<string, MethodName> = {
  browser_tabs_list: "tabs.list",
  browser_tabs_open: "tabs.open",
  browser_tabs_attach: "tabs.attach",
  browser_tabs_select: "tabs.select",
  browser_tabs_close: "tabs.close",
  browser_snapshot: "snapshot",
  browser_act: "act",
  browser_navigate: "navigate",
  browser_screenshot: "screenshot",
  browser_wait: "wait",
  browser_evaluate: "evaluate",
  browser_cdp: "cdp",
  browser_finish: "session.close",
};
