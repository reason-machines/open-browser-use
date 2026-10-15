// WS-C: STATIC MCP tool schemas, hand-derived from contract.ts (no runtime
// discovery, so `tools/list` is instant and stable across daemon versions).
// `sessionId` is injected by the proxy and never part of a tool's input.
import type { MethodName } from "../contract.js";

type JsonSchema = Record<string, unknown>;

export interface McpToolDef {
  name: string;
  method: MethodName;
  description: string;
  inputSchema: JsonSchema;
  readOnly?: boolean;
}

const tabId: JsonSchema = { type: "integer", description: "Tab to act on. Omit to use this session's active tab." };
const snapshotMode: JsonSchema = {
  type: "string",
  enum: ["diff", "tree", "none"],
  description: "What to return about the page afterwards: 'diff' (changes since your last snapshot), 'tree' (full snapshot) or 'none'.",
};
const ref: JsonSchema = { type: "string", description: "Element ref from the latest snapshot, e.g. 'e12' or 'f1e3' (inside iframe 1). Never put refs in CSS selectors." };
const coords: JsonSchema = {
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" } },
  required: ["x", "y"],
  additionalProperties: false,
  description: "Viewport coordinates (CSS px). Use only when there is no ref (canvas, maps).",
};

const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

export const MCP_TOOL_DEFS: McpToolDef[] = [
  {
    name: "browser_tabs_list",
    method: "tabs.list",
    readOnly: true,
    description:
      "List tabs. scope 'mine' (default) = tabs this agent owns or borrowed; 'mine+children' adds your subagents' tabs; 'browser' = the user's whole tab strip (read-only, to find a tab to attach).",
    inputSchema: object({ scope: { type: "string", enum: ["mine", "mine+children", "browser"] } }),
  },
  {
    name: "browser_tabs_open",
    method: "tabs.open",
    description:
      "Open a URL in a NEW background tab owned by this agent (never steals the user's focus) and make it your active tab. Returns once the page has settled. Pass snapshot:'tree' to get the page snapshot in the same call.",
    inputSchema: object(
      {
        url: { type: "string", description: "Absolute URL." },
        makeActive: { type: "boolean", description: "Default true." },
        snapshot: snapshotMode,
      },
      ["url"],
    ),
  },
  {
    name: "browser_tabs_attach",
    method: "tabs.attach",
    description: "Borrow one of the user's existing tabs (from browser_tabs_list scope 'browser') and make it your active tab. Borrowed tabs are never closed by you.",
    inputSchema: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "browser_tabs_select",
    method: "tabs.select",
    description: "Switch your active tab (agent-side only; does not change what the user sees).",
    inputSchema: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "browser_tabs_close",
    method: "tabs.close",
    description: "Close a tab you opened (a borrowed user tab is released, not closed).",
    inputSchema: object({ tabId: { type: "integer" } }, ["tabId"]),
  },
  {
    name: "browser_snapshot",
    method: "snapshot",
    readOnly: true,
    description:
      "Accessibility snapshot of the page as YAML with element refs ([ref=e12]). Includes content below the fold (no scrolling needed) and iframes. Use interactive:true for a cheap first look, ref/selector to scope. Returns a diff vs your previous snapshot too.",
    inputSchema: object({
      tabId,
      interactive: { type: "boolean", description: "Only interactive elements, headings and landmarks." },
      ref,
      selector: { type: "string", description: "CSS selector to scope the snapshot (main frame)." },
      showHidden: { type: "boolean" },
      maxChars: { type: "integer", description: "Default 40000. Larger pages return an error with advice instead of a truncated tree." },
    }),
  },
  {
    name: "browser_act",
    method: "act",
    description:
      "Act on an element and wait for the page to settle (no sleeps needed). Actions: click, dblclick, hover, fill (replace value), type (append keystrokes), press (keys like 'Enter', 'ControlOrMeta+A'), select (option value/label), check, uncheck, drag (to), upload (files), scroll (value: up|down|left|right). Target by ref (preferred), selector, or coords. Returns a snapshot diff by default.",
    inputSchema: object(
      {
        tabId,
        action: { type: "string", enum: ["click", "dblclick", "hover", "fill", "type", "press", "select", "check", "uncheck", "drag", "upload", "scroll"] },
        ref,
        selector: { type: "string" },
        coords,
        value: {
          anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
          description: "fill/type text, select option(s), or scroll direction.",
        },
        keys: { type: "string", description: "press: Playwright key syntax." },
        files: { type: "array", items: { type: "string" }, description: "upload: absolute local file paths." },
        to: object({ ref, selector: { type: "string" }, coords }),
        modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift", "ControlOrMeta"] } },
        button: { type: "string", enum: ["left", "right", "middle"] },
        timeoutMs: { type: "integer", description: "Actionability timeout, default 5000." },
        snapshot: snapshotMode,
      },
      ["action"],
    ),
  },
  {
    name: "browser_navigate",
    method: "navigate",
    description: "Navigate your tab to a URL, or go back/forward/reload, and wait until the page settles.",
    inputSchema: object({
      tabId,
      url: { type: "string" },
      op: { type: "string", enum: ["back", "forward", "reload"] },
      waitUntil: { type: "string", enum: ["settled", "domcontentloaded", "load", "none"] },
      snapshot: snapshotMode,
    }),
  },
  {
    name: "browser_screenshot",
    method: "screenshot",
    readOnly: true,
    description: "Screenshot of your tab (works for background tabs). annotate:true draws numbered ref boxes. Prefer browser_snapshot; use screenshots for visual checks, canvas and charts.",
    inputSchema: object({
      tabId,
      ref,
      fullPage: { type: "boolean" },
      annotate: { type: "boolean" },
      format: { type: "string", enum: ["jpeg", "webp", "png"] },
      quality: { type: "integer" },
      maxWidth: { type: "integer" },
    }),
  },
  {
    name: "browser_wait",
    method: "wait",
    description:
      "Wait for something that is not the direct result of an action: a download to finish, a popup, a dialog (optionally answer it with dialogAction), a selector/text/url to appear, or the page to settle.",
    inputSchema: object(
      {
        tabId,
        for: { type: "string", enum: ["download", "popup", "dialog", "selector", "text", "url", "settled"] },
        selector: { type: "string" },
        text: { type: "string" },
        url: { type: "string", description: "Glob (*, **) or substring." },
        dialogAction: object({ accept: { type: "boolean" }, promptText: { type: "string" } }, ["accept"]),
        timeoutMs: { type: "integer", description: "Default 30000." },
      },
      ["for"],
    ),
  },
  {
    name: "browser_evaluate",
    method: "evaluate",
    description: "Evaluate a JavaScript expression in the page and return its JSON value. Runs in an isolated world (sees the DOM, not page JS globals) unless world:'page'.",
    inputSchema: object(
      {
        tabId,
        expression: { type: "string" },
        world: { type: "string", enum: ["isolated", "page"] },
        awaitPromise: { type: "boolean" },
      },
      ["expression"],
    ),
  },
  {
    name: "browser_cdp",
    method: "cdp",
    description: "Escape hatch: send a raw Chrome DevTools Protocol command to your tab (Target.*, Browser.*, Runtime.enable, Debugger.enable are refused). frameRef 'f2' routes to an out-of-process iframe.",
    inputSchema: object(
      {
        tabId,
        method: { type: "string" },
        params: { type: "object" },
        frameRef: { type: "string" },
        timeoutMs: { type: "integer" },
      },
      ["method"],
    ),
  },
  {
    name: "browser_finish",
    method: "session.close",
    description:
      "Finish browsing: closes every tab you opened except the ones listed in keep (status 'deliverable' = result the user should see, 'handoff' = user must continue there). Call once at the end of the task.",
    inputSchema: object({
      keep: {
        type: "array",
        items: object({ tabId: { type: "integer" }, status: { type: "string", enum: ["handoff", "deliverable"] } }, ["tabId", "status"]),
      },
    }),
  },
];
