// Background robustness: viewport override coherence (I6, PLAN D7), focus theft (D6 #1),
// focus emulation only while acting (I7), no Runtime.enable leaks (I8, best effort).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingAware, refOf } from "./lib/harness.mjs";
import { startFocusSampler } from "./lib/focus.mjs";

const e2e = pendingAware(test);

e2e("I6: owned tabs get a coherent 1440x900 desktop viewport (screen.* not contradicting)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("vp");
  const tab = await ctx.open(s, "viewport-probe.html");
  await ctx.snap(tab, { interactive: true });
  const p = await ctx.fx(tab, "probe()");
  ctx.t.diagnostic(`owned probe ${JSON.stringify(p)}`);
  assert.deepEqual(p.inner, [1440, 900]);
  assert.equal(p.mqDesktop, true);
  assert.equal(p.coherent, true, "screen >= inner (sites reading screen.* see a sane desktop)");
});

e2e("I6: borrowed tabs keep the user's real viewport (no override)", async (ctx) => {
  ctx.requireExtension();
  const user = await ctx.userTab("viewport-probe.html");
  const s = await ctx.session("vp-borrow");
  const id = (await s.call("tabs.list", { scope: "browser" })).tabs.find((x) => x.url.endsWith("/viewport-probe.html"))?.tabId;
  assert.ok(id);
  await s.call("tabs.attach", { tabId: id });
  await s.call("snapshot", { tabId: id, interactive: true });
  const p = await ctx.fx({ targetId: user.targetId, tabId: id, sessionId: s.sessionId }, "probe()");
  assert.notDeepEqual(p.inner, [1440, 900], "borrowed tab not overridden");
});

e2e("D6#1: a busy agent workload never hides the user's foreground tab", async (ctx) => {
  ctx.requireExtension();
  ctx.requireCdp();
  const focus = await startFocusSampler(ctx.env);
  const s = await ctx.session("focus");
  const tabs = [await ctx.open(s, "form.html"), await ctx.open(s, "editable.html"), await ctx.open(s, "bench.html")];
  for (const tab of tabs) {
    const { tree } = await ctx.snap(tab);
    const btn = tree.match(/button "[^"]+" \[ref=(\w+)\]/)?.[1];
    if (btn) await ctx.act(tab, { action: "click", ref: btn });
    await s.call("screenshot", { tabId: tab.tabId });
  }
  await ctx.act(tabs[1], { action: "type", selector: "#ta", value: "typing in the background" });
  const report = await focus.stop();
  ctx.t.diagnostic(JSON.stringify(report));
  assert.ok(report.samples > 3);
  assert.equal(report.thefts, 0, `focus theft: ${JSON.stringify(report)}`);
});

e2e("I7: focus emulation is off again after act returns", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("i7");
  const tab = await ctx.open(s, "editable.html");
  const { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /textbox "Notes"/) });
  const hasFocus = await ctx.fx(tab, "document.hasFocus()");
  assert.equal(hasFocus, false, "background agent tab must not keep emulated focus between calls");
});

e2e("I8: agent pages show no automation tells (best effort on this Chrome)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("i8");
  const tab = await ctx.open(s, "detect.html");
  const { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Ping"/) });
  await s.call("screenshot", { tabId: tab.tabId });
  assert.equal(await ctx.fx(tab, "__fx.state.runtimeEnabled"), false);
  assert.equal(await ctx.fx(tab, "navigator.webdriver === true"), false);
});
