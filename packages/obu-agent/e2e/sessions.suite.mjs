// Sessions, tabs, leases and invariants I1–I5 (contract.md §Invariants) + the user rule:
// no agent-owned tabs remain after session close.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "../dist/index.js";
import { expectCode, getEnv, pendingAware, restartDaemon, sleep, Pending } from "./lib/harness.mjs";
import { startFocusSampler } from "./lib/focus.mjs";

const e2e = pendingAware(test);

e2e("sessions: daemon.info speaks the contract version", async ({ env, client }) => {
  const info = await client.call("daemon.info", {});
  assert.equal(info.contractVersion, CONTRACT_VERSION);
  assert.equal(typeof info.pid, "number");
  if (!info.extension.connected) throw new Pending(`extension not connected (notes: ${env.notes.join("; ")})`);
});

e2e("sessions: open is idempotent and heartbeat renews the lease", async (ctx) => {
  const s = await ctx.session("idem");
  assert.equal(s.leaseTtlMs, 60_000);
  assert.equal(s.heartbeatIntervalMs, 15_000);
  const again = await ctx.client.call("session.open", { sessionId: s.sessionId, label: "idem" });
  assert.equal(again.sessionId, s.sessionId);
  const { expiresAt } = await s.call("session.heartbeat");
  assert.ok(expiresAt > Date.now() + 50_000, "lease extends ~60 s");
});

e2e("sessions: unknown session is a typed error", async (ctx) => {
  await expectCode(ctx.client.call("tabs.list", { sessionId: "does-not-exist" }), "unknown_session");
});

e2e("tabs: open creates an owned background tab without stealing focus", async (ctx) => {
  ctx.requireExtension();
  const focus = ctx.env.cdp ? await startFocusSampler(ctx.env) : null;
  const s = await ctx.session("open");
  const tab = await ctx.open(s, "form.html");
  const report = await focus?.stop();
  assert.equal(typeof tab.tabId, "number");
  assert.ok(tab.targetId, "targetId returned");
  assert.equal(tab.title, "Form fixture");
  assert.ok(tab.settled && ["nav", "dom", "spa", "none"].includes(tab.settled.kind));
  if (ctx.env.cdp) assert.equal(await ctx.targetAlive(tab.targetId), true, "target exists in Chrome");
  if (report) assert.equal(report.thefts, 0, `focus theft: ${JSON.stringify(report)}`);
  const { tabs, activeTabId } = await s.call("tabs.list", { scope: "mine" });
  assert.equal(activeTabId, tab.tabId);
  assert.deepEqual(tabs.map((x) => x.tabId), [tab.tabId]);
  assert.equal(tabs[0].ownership, "owned");
});

e2e("tabs: list scopes isolate sessions; browser scope is the read-only user strip", async (ctx) => {
  ctx.requireExtension();
  const a = await ctx.session("scope-a"), b = await ctx.session("scope-b");
  const ta = await ctx.open(a, "table.html"), tb = await ctx.open(b, "select.html");
  const mineA = (await a.call("tabs.list", { scope: "mine" })).tabs.map((x) => x.tabId);
  assert.deepEqual(mineA, [ta.tabId], "a sees only its own tab");
  assert.ok(!mineA.includes(tb.tabId));
  if (ctx.env.cdp) {
    await ctx.userTab("hidden.html");
    const browser = (await a.call("tabs.list", { scope: "browser" })).tabs;
    assert.ok(browser.some((x) => x.url.endsWith("/hidden.html")), "user tab visible in browser scope");
  }
});

e2e("I1: page calls default to the active tab; select/makeActive switch it", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("active");
  const t1 = await ctx.open(s, "table.html");
  const t2 = await ctx.open(s, "select.html", { makeActive: false });
  let snap = await s.call("snapshot", { interactive: true });
  assert.equal(snap.tabId, t1.tabId, "makeActive:false kept t1 active");
  await s.call("tabs.select", { tabId: t2.tabId });
  snap = await s.call("snapshot", { interactive: true });
  assert.equal(snap.tabId, t2.tabId);
  assert.equal(snap.title, "Select fixture");
});

e2e("I2: child sessions cannot act on parent tabs until transferred", async (ctx) => {
  ctx.requireExtension();
  const parent = await ctx.session("parent");
  const child = await ctx.session("child", { parentSessionId: parent.sessionId });
  const tab = await ctx.open(parent, "form.html");
  await expectCode(child.call("snapshot", { tabId: tab.tabId }), "tab_not_owned");
  await expectCode(child.call("act", { tabId: tab.tabId, action: "click", selector: "#submit" }), "tab_not_owned");
  const family = (await parent.call("tabs.list", { scope: "mine+children" })).tabs;
  assert.ok(family.some((x) => x.tabId === tab.tabId));
  await parent.call("tabs.transfer", { tabId: tab.tabId, toSessionId: child.sessionId });
  const snap = await child.call("snapshot", { tabId: tab.tabId, interactive: true });
  assert.equal(snap.tabId, tab.tabId);
  await expectCode(parent.call("snapshot", { tabId: tab.tabId }), "tab_not_owned");
});

e2e("close: owned tabs are closed, kept deliverables and borrowed tabs survive (no leftovers)", async (ctx) => {
  ctx.requireExtension();
  ctx.requireCdp();
  const s = await ctx.session("close");
  const t1 = await ctx.open(s, "table.html");
  const t2 = await ctx.open(s, "form.html");
  const t3 = await ctx.open(s, "select.html");
  const user = await ctx.userTab("hidden.html");
  const browser = (await s.call("tabs.list", { scope: "browser" })).tabs;
  const userTabId = browser.find((x) => x.url.endsWith("/hidden.html"))?.tabId;
  assert.ok(userTabId, "user tab id visible");
  const borrowed = await s.call("tabs.attach", { tabId: userTabId });
  assert.equal(borrowed.tab.ownership, "borrowed");
  const r = await s.call("session.close", { keep: [{ tabId: t3.tabId, status: "deliverable" }] });
  assert.deepEqual([...r.closedTabIds].sort(), [t1.tabId, t2.tabId].sort());
  assert.deepEqual(r.keptTabIds, [t3.tabId]);
  assert.ok(await ctx.waitTargetGone(t1.targetId), "t1 closed in Chrome");
  assert.ok(await ctx.waitTargetGone(t2.targetId), "t2 closed in Chrome");
  assert.equal(await ctx.targetAlive(t3.targetId), true, "deliverable kept");
  assert.equal(await ctx.targetAlive(user.targetId), true, "borrowed user tab untouched");
  await ctx.env.cdp.send("Target.closeTarget", { targetId: t3.targetId }); // test cleanup (RAM rule)
});

e2e("parallel: 4 sessions x 1 owned tab act concurrently with no cross-talk and no leftovers", async (ctx) => {
  ctx.requireExtension();
  const focus = ctx.env.cdp ? await startFocusSampler(ctx.env) : null;
  const sessions = await Promise.all([0, 1, 2, 3].map((i) => ctx.session(`par${i}`)));
  const tabs = await Promise.all(sessions.map((s) => ctx.open(s, "bench.html")));
  await Promise.all(tabs.map(async (tab, i) => {
    for (let k = 0; k <= i + 2; k++) await ctx.act(tab, { action: "click", selector: "#inc", snapshot: "none" });
  }));
  for (const [i, tab] of tabs.entries()) assert.equal(await ctx.fx(tab, "__fx.state.count"), i + 3, `tab ${i} count`);
  await Promise.all(sessions.map((s) => s.call("session.close")));
  if (ctx.env.cdp) for (const tab of tabs) assert.ok(await ctx.waitTargetGone(tab.targetId, 60_000), "no agent tab left after close");
  const report = await focus?.stop();
  if (report) assert.equal(report.thefts, 0, `focus theft: ${JSON.stringify(report)}`);
});

e2e("cdp escape hatch refuses Target.*, Browser.* and Runtime.enable (I8)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("deny");
  await ctx.open(s, "detect.html");
  await expectCode(s.call("cdp", { method: "Target.getTargets" }), "cdp_denied");
  await expectCode(s.call("cdp", { method: "Browser.getVersion" }), "cdp_denied");
  await expectCode(s.call("cdp", { method: "Runtime.enable" }), "cdp_denied");
  await expectCode(s.call("cdp", { method: "Debugger.enable" }), "cdp_denied");
  const ok = await s.call("cdp", { method: "Page.getLayoutMetrics" });
  assert.ok(ok.result.cssLayoutViewport);
});

e2e("events: user closing an owned tab is reported (tab_closed reason user)", async (ctx) => {
  ctx.requireExtension();
  ctx.requireCdp();
  const s = await ctx.session("userclose");
  const tab = await ctx.open(s, "table.html");
  const before = await s.call("session.events", { afterSeq: 0 });
  await ctx.env.cdp.send("Target.closeTarget", { targetId: tab.targetId });
  const r = await s.call("session.events", { afterSeq: before.lastSeq, waitMs: 3000 });
  const ev = r.events.find((e) => e.type === "tab_closed" || e.type === "lease_revoked");
  assert.ok(ev, `expected tab_closed/lease_revoked, got ${JSON.stringify(r.events)}`);
  if (ev.type === "tab_closed") assert.equal(ev.reason, "user");
  assert.equal((await s.call("tabs.list", { scope: "mine" })).tabs.length, 0);
});

e2e("I4: lease expiry finalizes the session (E2E_SLOW=1, ~65 s)", { timeout: 120_000 }, async (ctx) => {
  if (process.env.E2E_SLOW !== "1") return ctx.t.skip("set E2E_SLOW=1 to run the 60 s lease-expiry test");
  ctx.requireExtension();
  const s = await ctx.session("lease");
  const tab = await ctx.open(s, "table.html");
  await sleep(63_000);
  if (ctx.env.cdp) assert.ok(await ctx.waitTargetGone(tab.targetId, 5000), "owned tab closed on lease expiry");
  await expectCode(s.call("tabs.list", {}), "unknown_session");
});

e2e("I5: daemon restart reconciles orphaned agent tabs", { timeout: 60_000 }, async (ctx) => {
  ctx.requireExtension();
  ctx.requireCdp();
  const s = await ctx.session("orphan");
  const tab = await ctx.open(s, "table.html");
  await restartDaemon(ctx.env);
  assert.ok(await ctx.waitTargetGone(tab.targetId, 15_000), "orphan agent tab closed after daemon restart");
});
