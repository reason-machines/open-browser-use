import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { JsonRpcError, JsonRpcRequest, JsonRpcSuccess, MethodName, ParamsOf, ResultOf } from "../contract.js";
import { ObuError, toJsonRpcError } from "../errors.js";

/** Newline-delimited JSON framing over a stream socket. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffered = "";
  return (chunk) => {
    buffered += chunk.toString("utf8");
    let index: number;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index).trim();
      buffered = buffered.slice(index + 1);
      if (line) onLine(line);
    }
  };
}

export interface RequestContext {
  /** Connection-scoped; lets the server finalize sessions opened by a dropped connection if desired. */
  connectionId: number;
}

export type Handler = (params: unknown, ctx: RequestContext) => Promise<unknown> | unknown;
export type HandlerTable = Partial<Record<MethodName, Handler>>;

export interface ServeOptions {
  /**
   * Shared secret (contents of agent.token). When set, the first line of every
   * connection must be `{"auth":"<token>"}`; the server answers
   * `{"jsonrpc":"2.0","id":"auth","result":{"ok":true}}` or closes the socket.
   */
  token?: string;
}

/** JSON-RPC 2.0 server over a unix socket (or any net path). WS-C owns everything past this framing. */
export function serveJsonRpc(path: string, handlers: HandlerTable, options: ServeOptions = {}): Promise<Server> {
  let nextConnection = 1;
  const server = createServer((socket: Socket) => {
    const ctx: RequestContext = { connectionId: nextConnection++ };
    let authed = !options.token;
    socket.on(
      "data",
      lineReader((line) => {
        if (!authed) {
          let ok = false;
          try {
            ok = timingSafeEqualString((JSON.parse(line) as { auth?: unknown }).auth, options.token!);
          } catch {
            ok = false;
          }
          if (!ok) {
            write(socket, { jsonrpc: "2.0", id: "auth", error: { code: -32001, message: "unauthorized: send {\"auth\":\"<agent.token>\"} first" } });
            socket.end();
            return;
          }
          authed = true;
          write(socket, { jsonrpc: "2.0", id: "auth", result: { ok: true } });
          return;
        }
        void dispatch(line, socket, handlers, ctx);
      }),
    );
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve(server));
  });
}

async function dispatch(line: string, socket: Socket, handlers: HandlerTable, ctx: RequestContext): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    write(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const id = request.id ?? null;
  try {
    const handler = handlers[request.method as MethodName];
    if (!handler) throw new ObuError("method_not_found", `unknown method ${request.method}`);
    const result = await handler(request.params ?? {}, ctx);
    if (id !== null) write(socket, { jsonrpc: "2.0", id, result: result ?? null });
  } catch (error) {
    write(socket, toJsonRpcError(id, error));
  }
}

function timingSafeEqualString(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function write(socket: Socket, message: JsonRpcSuccess | JsonRpcError): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

/** Typed client for the daemon socket. Used by tests, the MCP proxy, the bench and WS-F. */
export class ObuAgentClient {
  #socket: Socket | null = null;
  #nextId = 1;
  #pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  #connecting: Promise<this> | null = null;

  constructor(
    readonly path: string,
    readonly options: { token?: string; timeoutMs?: number } = {},
  ) {}

  connect(): Promise<this> {
    if (this.#socket) return Promise.resolve(this);
    if (!this.#connecting) {
      this.#connecting = this.#connect().finally(() => (this.#connecting = null));
    }
    return this.#connecting;
  }

  async #connect(): Promise<this> {
    const socket = createConnection(this.path);
    socket.on(
      "data",
      lineReader((line) => {
        const message = JSON.parse(line) as JsonRpcSuccess | JsonRpcError;
        if (message.id === null || message.id === undefined) return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if ("error" in message) {
          const data = message.error.data;
          pending.reject(data ? new ObuError(data.code, message.error.message, data) : new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }),
    );
    const fail = (error: Error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      this.#socket = null;
    };
    socket.on("close", () => fail(new Error("obu-agent socket closed")));
    socket.on("error", fail);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    this.#socket = socket;
    if (this.options.token) {
      const ack = new Promise<unknown>((resolve, reject) => this.#pending.set("auth", { resolve, reject }));
      socket.write(`${JSON.stringify({ auth: this.options.token })}\n`);
      await ack;
    }
    return this;
  }

  async call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    await this.connect();
    const id = this.#nextId++;
    const timeoutMs = this.options.timeoutMs;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.#pending.delete(id);
        reject(new ObuError("timeout", `${method} timed out after ${timeoutMs} ms (client)`, { stage: "client" }));
      }, timeoutMs) : undefined;
      this.#pending.set(id, {
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.#socket!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return (await promise) as ResultOf<M>;
  }

  /** Untyped call (MCP proxy, CLI). */
  request(method: string, params: unknown): Promise<unknown> {
    return this.call(method as MethodName, params as never);
  }

  get connected(): boolean {
    return this.#socket !== null;
  }

  close(): void {
    this.#socket?.end();
    this.#socket = null;
  }
}
