import { ERROR_CODES, type ErrorCode, type JsonRpcError, type ObuErrorData } from "./contract.js";

/** Typed daemon error. `message` is passed to the agent verbatim — make it actionable. */
export class ObuError extends Error {
  readonly code: ErrorCode;
  readonly data: ObuErrorData;

  constructor(code: ErrorCode, message: string, data: Omit<ObuErrorData, "code"> = {}) {
    super(message);
    this.name = "ObuError";
    this.code = code;
    this.data = { code, ...data };
  }

  toJsonRpc(id: string | number | null): JsonRpcError {
    return { jsonrpc: "2.0", id, error: { code: ERROR_CODES[this.code], message: this.message, data: this.data } };
  }
}

export function toJsonRpcError(id: string | number | null, error: unknown): JsonRpcError {
  if (error instanceof ObuError) return error.toJsonRpc(id);
  const message = error instanceof Error ? error.message : String(error);
  return new ObuError("internal", message).toJsonRpc(id);
}

export function notImplemented(method: string, owner: string): ObuError {
  return new ObuError("not_implemented", `${method} is not implemented yet (owner: ${owner})`);
}
