// WS-D: the injected bundle source. Built into a single IIFE string that WS-C
// injects into the utility world. Installs globalThis.__obu (see api.ts).
export type { ObuInjectedApi } from "./api.js";

/** Bundle source to inject. WS-D replaces this with the real build output. */
export const INJECTED_BUNDLE_SOURCE = "/* obu injected bundle: not built yet (WS-D) */";
export const INJECTED_VERSION = "0.0.0";
