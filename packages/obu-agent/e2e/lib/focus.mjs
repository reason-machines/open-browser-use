// Focus-theft sampler (PLAN D6 #1: zero changes to the user's active tab or frontmost app).
//  - CfT mode: a "user" sentinel tab (fixtures/sentinel.html) is opened in the foreground and
//    sampled every 250 ms over raw CDP; any visibility→hidden is theft (agent tab activated).
//  - Frontmost app (macOS, osascript) sampled every 250 ms in every mode when
//    E2E_FOCUS_FRONTMOST=1 (off by default: the user may legitimately switch apps).
import { execFile } from "node:child_process";
import { attachPage } from "./cdp.mjs";

function frontmostApp() {
  return new Promise((resolve) => execFile("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 2000 }, (e, out) => resolve(e ? null : out.trim())));
}

export async function startFocusSampler(env, { intervalMs = 250 } = {}) {
  const samples = { sentinel: [], frontmost: [] };
  let sentinel = null, timer = null, stopped = false;
  if (env.cdp) {
    const { targetId } = await env.cdp.send("Target.createTarget", { url: env.fixtures.url("sentinel.html"), background: false });
    await env.cdp.send("Target.activateTarget", { targetId });
    sentinel = { targetId, page: await attachPage(env.cdp, targetId) };
    await new Promise((r) => setTimeout(r, 300));
  }
  const baseFront = process.env.E2E_FOCUS_FRONTMOST === "1" ? await frontmostApp() : null;
  const tick = async () => {
    if (stopped) return;
    if (sentinel) {
      const v = await sentinel.page.evaluate("document.visibilityState").catch((e) => `error:${e.message}`);
      samples.sentinel.push(v);
    }
    if (baseFront !== null) samples.frontmost.push(await frontmostApp());
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  await tick();
  return {
    sentinelTargetId: sentinel?.targetId,
    async stop() {
      stopped = true; clearTimeout(timer);
      let events = [];
      if (sentinel) {
        events = await sentinel.page.evaluate("__fx.events").catch(() => []);
        await sentinel.page.detach();
        await env.cdp.send("Target.closeTarget", { targetId: sentinel.targetId }).catch(() => {});
      }
      const hidden = samples.sentinel.filter((v) => v !== "visible").length;
      const frontChanges = baseFront === null ? 0 : samples.frontmost.filter((v) => v && v !== baseFront).length;
      return { samples: samples.sentinel.length + samples.frontmost.length, sentinelHidden: hidden, frontmostChanges: frontChanges, baseFront, sentinelEvents: events, thefts: hidden + frontChanges };
    },
  };
}
