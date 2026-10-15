// Single e2e entry: every suite shares one fixture server + Chrome + daemon (lib/harness.mjs),
// and the top-level after() quits Chrome / kills the daemon / closes servers once all suites
// finish (user rule: no orphan Chromes or tabs). Select suites with E2E_SUITES=fixtures,sessions.
// Run: pnpm --filter obu-agent e2e   (E2E_STRICT=1 = merge gate: pending counts as failure)
import { after } from "node:test";
import { readdirSync } from "node:fs";
import { teardown } from "./lib/harness.mjs";

after(teardown);
const only = (process.env.E2E_SUITES ?? "").split(",").filter(Boolean);
const suites = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".suite.mjs")).sort()
  .filter((f) => !only.length || only.some((x) => f.startsWith(x)));
for (const f of suites) await import(`./${f}`);
