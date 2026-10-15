// WS-C: session registry, tab ownership (I1, I2), transfer, finalize.
import type { SessionCloseParams, SessionCloseResult, SessionOpenParams, SessionOpenResult } from "../contract.js";
import { notImplemented } from "../errors.js";
export { KeyedMutex } from "./mutex.js";

export interface SessionManager {
  open(params: SessionOpenParams): Promise<SessionOpenResult>;
  close(params: SessionCloseParams): Promise<SessionCloseResult>;
}

export function createSessionManager(): SessionManager {
  return {
    open: async () => {
      throw notImplemented("session.open", "WS-C");
    },
    close: async () => {
      throw notImplemented("session.close", "WS-C");
    },
  };
}
