// Dialogs, popups and steering events (contract.md §Dialogs, §System events).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingAware, refOf, sleep } from "./lib/harness.mjs";

const e2e = pendingAware(test);
const dialogEvent = (res, type) => (res.events ?? []).find((e) => e.type === "dialog" && e.dialogType === type);

e2e("dialogs: alert auto-accepted, confirm accepted, prompt dismissed — all reported, never hung", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("dlg");
  const tab = await ctx.open(s, "dialogs.html");
  const { tree } = await ctx.snap(tab);
  let r = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Show alert"/) });
  assert.equal(dialogEvent(r, "alert")?.action, "accepted", JSON.stringify(r.events));
  assert.equal(dialogEvent(r, "alert")?.message, "Hello from alert");
  assert.equal(await ctx.fx(tab, "__fx.count('alert-closed')"), 1);
  r = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Show confirm"/) });
  assert.equal(dialogEvent(r, "confirm")?.action, "accepted");
  assert.equal(await ctx.fx(tab, "__fx.state.confirm"), true);
  r = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Show prompt"/) });
  assert.equal(dialogEvent(r, "prompt")?.action, "dismissed");
  assert.equal(await ctx.fx(tab, "__fx.state.prompt"), null);
});

e2e("dialogs: pending wait{dialog, dialogAction} answers the next prompt", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("dlg-wait");
  const tab = await ctx.open(s, "dialogs.html");
  const { tree } = await ctx.snap(tab);
  const waiting = s.call("wait", { tabId: tab.tabId, for: "dialog", dialogAction: { accept: true, promptText: "Ada" }, timeoutMs: 10_000 });
  await sleep(150);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Show prompt"/) });
  const w = await waiting;
  assert.equal(w.ok, true);
  assert.equal(await ctx.fx(tab, "__fx.state.prompt"), "Ada");
});

e2e("dialogs: beforeunload does not hang navigation; native <dialog> modal is actionable", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("dlg-bu");
  const tab = await ctx.open(s, "dialogs.html");
  let { tree } = await ctx.snap(tab);
  const m = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Open modal dialog element"/), snapshot: "tree" });
  await ctx.act(tab, { action: "click", ref: refOf(m.snapshot?.tree ?? (await ctx.snap(tab)).tree, /button "Close modal"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('modal-closed')"), 1);
  await ctx.act(tab, { action: "check", ref: refOf(tree, /checkbox "Warn before leaving/) });
  const t0 = performance.now();
  const nav = await s.call("navigate", { tabId: tab.tabId, url: ctx.url("form.html") });
  assert.ok(performance.now() - t0 < 10_000);
  assert.equal(nav.ok, true);
  assert.equal((await s.call("snapshot", { tabId: tab.tabId, interactive: true })).title, "Form fixture");
});

e2e("popups: window.open / target=_blank are adopted as owned tabs and reported", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("popup");
  const tab = await ctx.open(s, "popup.html");
  const { tree } = await ctx.snap(tab);
  const r1 = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "window.open popup"/) });
  const ev1 = (r1.events ?? []).find((e) => e.type === "popup_opened");
  assert.ok(ev1, `popup_opened in events: ${JSON.stringify(r1.events)}`);
  assert.equal(ev1.openerTabId, tab.tabId);
  const r2 = await ctx.act(tab, { action: "click", ref: refOf(tree, /link "Open form in new tab/) });
  const ev2 = (r2.events ?? []).find((e) => e.type === "popup_opened");
  assert.ok(ev2, "target=_blank reported");
  const mine = (await s.call("tabs.list", { scope: "mine" })).tabs;
  assert.equal(mine.length, 3, JSON.stringify(mine));
  assert.ok(mine.every((x) => x.ownership === "owned"));
  const closed = await s.call("session.close");
  assert.equal(closed.closedTabIds.length, 3, "popups closed with the session (no leftovers)");
  if (ctx.env.cdp) {
    const left = (await ctx.pageTargets()).filter((x) => /popup\.html|form\.html/.test(x.url));
    assert.equal(left.length, 0, `leftover tabs: ${left.map((x) => x.url)}`);
  }
});

e2e("popups: OAuth-style popup flow (act in popup tab, it closes, opener gets result)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("oauth");
  const tab = await ctx.open(s, "popup.html");
  const { tree } = await ctx.snap(tab);
  const r = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Sign in with Fixture/) });
  const ev = (r.events ?? []).find((e) => e.type === "popup_opened");
  assert.ok(ev, "popup reported");
  const popup = { tabId: ev.tab.tabId, targetId: ev.tab.targetId, s, sessionId: s.sessionId };
  const ptree = (await ctx.snap(popup)).tree;
  await ctx.act(popup, { action: "fill", ref: refOf(ptree, /textbox "Username"/), value: "ada" });
  const allow = await ctx.act(popup, { action: "click", ref: refOf(ptree, /button "Allow"/) });
  assert.equal(await ctx.until(tab, "__fx.state.oauth || null", Boolean, 3000), "ada");
  const evs = [...(allow.events ?? []), ...(await s.call("session.events", { afterSeq: 0 })).events];
  assert.ok(evs.some((e) => e.type === "tab_closed" && e.tabId === popup.tabId), "popup self-close reported");
  const { activeTabId } = await s.call("tabs.list", { scope: "mine" });
  assert.equal(activeTabId, tab.tabId, "active tab falls back to the opener");
});
