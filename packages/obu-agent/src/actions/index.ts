// WS-E: element actions with actionability, hit test, CDP input and verify fallbacks (A5).
import type { ActParams, ActResult } from "../contract.js";
import { notImplemented } from "../errors.js";
import type { PageContext } from "../seams.js";

export async function act(_page: PageContext, _params: ActParams): Promise<Omit<ActResult, "events" | "snapshot">> {
  throw notImplemented("act", "WS-E");
}
