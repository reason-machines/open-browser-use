// WS-D: the injected bundle. `installObu` is self-contained, so the bundle is
// simply its compiled source wrapped in an IIFE. WS-C injects
// INJECTED_BUNDLE_SOURCE into the utility world of every frame; it installs
// globalThis.__obu (see api.ts) and is idempotent per version.
import { installObu } from "./runtime.js";

export type { ObuInjectedApi, InjectedSnapshot, TakeSnapshotOptions, SettleProbe, Rect, ReadyFailure } from "./api.js";

export const INJECTED_VERSION = "1.0.0";

/** Source to evaluate in the isolated world. Evaluates to `true` once installed. */
export const INJECTED_BUNDLE_SOURCE = `(${installObu.toString()})();\ntrue;`;

/** Expression that health-checks the bundle (returns the installed version or ''). */
export const INJECTED_HEALTH_EXPRESSION = "(globalThis.__obu && globalThis.__obu.version) || ''";
