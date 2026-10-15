// WS-C: MCP stdio proxy (`obu-agent mcp --attach`) with STATIC tool schemas
// derived from contract.ts (no runtime discovery). One MCP process = one daemon
// session (subagents run their own proxy with --parent).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { MethodName, SystemEvent } from "../contract.js";
import { ObuError } from "../errors.js";
import { renderSystemEvents } from "../events.js";
import { ObuAgentClient } from "../server/rpc.js";
import { MCP_TOOL_DEFS, type McpToolDef } from "./schemas.js";

export { MCP_TOOL_DEFS, type McpToolDef } from "./schemas.js";

/** MCP tool name -> daemon method. */
export const MCP_TOOLS: Record<string, MethodName> = Object.fromEntries(MCP_TOOL_DEFS.map((tool) => [tool.name, tool.method]));

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpProxyOptions {
  socketPath: string;
  tokenPath?: string;
  sessionId: string;
  parentSessionId?: string;
  label?: string;
  profile?: string;
  /** Spawn the daemon when the socket is not there (argv for `node`). */
  spawnDaemon?: string[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  log?: (line: string) => void;
}

/** Render a daemon result for a model: JSON (events stripped) + `[system]` lines. */
export function renderToolResult(result: unknown): { text: string; events: SystemEvent[] } {
  if (!result || typeof result !== "object") return { text: JSON.stringify(result ?? null), events: [] };
  const { events, ...rest } = result as { events?: SystemEvent[] };
  const snapshot = (rest as { snapshot?: { tree?: string; diff?: string } }).snapshot;
  const tree = (rest as { tree?: string }).tree;
  let text: string;
  if (typeof tree === "string") {
    // snapshot result: show the YAML raw, metadata as a compact header.
    const { tree: _tree, diff, ...meta } = rest as { tree: string; diff?: string };
    text = `${JSON.stringify(meta)}\n${tree}${diff ? `\n--- diff vs previous snapshot ---\n${diff}` : ""}`;
  } else if (snapshot && (snapshot.tree || snapshot.diff)) {
    const { snapshot: _s, ...meta } = rest as { snapshot: unknown };
    text = `${JSON.stringify({ ...meta, url: (snapshot as any).url, title: (snapshot as any).title })}\n${snapshot.tree ?? `--- page changes ---\n${snapshot.diff || "(no changes)"}`}`;
  } else {
    text = JSON.stringify(rest);
  }
  const lines = events?.length ? `\n${renderSystemEvents(events)}` : "";
  return { text: text + lines, events: events ?? [] };
}

export async function runMcpProxy(options: McpProxyOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((line: string) => process.stderr.write(`[obu-agent mcp] ${line}\n`));
  const client = await connectOrSpawn(options, log);
  const open = () =>
    client.request("session.open", {
      sessionId: options.sessionId,
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    });
  await open();
  let closed = false;
  const heartbeat = setInterval(() => {
    client.request("session.heartbeat", { sessionId: options.sessionId }).catch(async (error) => {
      if (error instanceof ObuError && error.code === "unknown_session" && !closed) await open().catch(() => undefined);
    });
  }, 15_000);
  heartbeat.unref();

  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const tools = new Map(MCP_TOOL_DEFS.map((tool) => [tool.name, tool]));

  const callTool = async (tool: McpToolDef, args: Record<string, unknown>) => {
    const params = { ...args, sessionId: options.sessionId };
    let result: unknown;
    try {
      result = await client.request(tool.method, params);
    } catch (error) {
      if (error instanceof ObuError && error.code === "unknown_session" && tool.method !== "session.close") {
        await open();
        result = await client.request(tool.method, params);
      } else {
        throw error;
      }
    }
    if (tool.method === "session.close") {
      closed = true;
    }
    const { text } = renderToolResult(result);
    const content: unknown[] = [{ type: "text", text }];
    const path = (result as { path?: string; mime?: string })?.path;
    const mime = (result as { mime?: string })?.mime;
    if (tool.method === "screenshot" && path && mime && existsSync(path)) {
      const data = readFileSync(path);
      if (data.length < 4 * 1024 * 1024) content.push({ type: "image", data: data.toString("base64"), mimeType: mime });
    }
    return { content };
  };

  const handle = async (message: any) => {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    try {
      let result: unknown;
      switch (method) {
        case "initialize":
          result = {
            protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "obu-agent", version: "0.1.0" },
            instructions:
              "Browser tools for the user's real Chrome. Each agent gets its own background tabs (browser_tabs_open) and one active tab. Read pages with browser_snapshot (refs like e12), act with browser_act (it waits for the page to settle: never sleep), and call browser_finish at the end.",
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = {
            tools: MCP_TOOL_DEFS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
            })),
          };
          break;
        case "tools/call": {
          const tool = tools.get(params?.name);
          if (!tool) throw Object.assign(new Error(`unknown tool ${params?.name}`), { rpcCode: -32602 });
          try {
            result = await callTool(tool, (params?.arguments ?? {}) as Record<string, unknown>);
          } catch (error) {
            const data = error instanceof ObuError ? error.data : undefined;
            result = {
              content: [{ type: "text", text: `${(error as Error).message}${data ? `\n${JSON.stringify(data)}` : ""}` }],
              isError: true,
            };
          }
          break;
        }
        default:
          if (!isRequest) return; // notifications (initialized, cancelled, …)
          throw Object.assign(new Error(`method not found: ${method}`), { rpcCode: -32601 });
      }
      if (isRequest) send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (isRequest) send({ jsonrpc: "2.0", id, error: { code: (error as { rpcCode?: number }).rpcCode ?? -32603, message: (error as Error).message } });
    }
  };

  const reader = createInterface({ input });
  reader.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    void handle(message);
  });
  await new Promise<void>((resolve) => reader.once("close", () => resolve()));
  clearInterval(heartbeat);
  if (!closed) await client.request("session.close", { sessionId: options.sessionId }).catch(() => undefined);
  client.close();
}

async function connectOrSpawn(options: McpProxyOptions, log: (line: string) => void): Promise<ObuAgentClient> {
  const token = () => (options.tokenPath && existsSync(options.tokenPath) ? readFileSync(options.tokenPath, "utf8").trim() : undefined);
  const tryConnect = async () => {
    const client = new ObuAgentClient(options.socketPath, { token: token() });
    await client.connect();
    return client;
  };
  try {
    return await tryConnect();
  } catch (error) {
    if (!options.spawnDaemon) throw error;
  }
  log(`daemon not running at ${options.socketPath}; starting it`);
  const child = spawn(process.execPath, options.spawnDaemon, { detached: true, stdio: "ignore" });
  child.unref();
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      return await tryConnect();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`obu-agent daemon did not come up at ${options.socketPath}: ${(lastError as Error)?.message ?? lastError}`);
}
