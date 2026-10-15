// Agent wire v2 (WS-A): child CDP sessions, implicit attach, subscriptions,
// root-session groups + close guard, popups, lease events, download
// correlation, route checks, chunked frames, branding.
// Run: node --test apps/chrome-extension/agent-wire.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createChromeFake, loadBackground, notifications, rpc, settle } from "./test-support/chrome-fake.mjs";

const S = (session_id, extra = {}) => ({ session_id, turn_id: "turn-1", ...extra });

async function setup(options) {
  const fake = createChromeFake(options);
  const bg = await loadBackground(fake);
  return { fake, bg };
}

async function ok(fake, method, params) {
  const response = await rpc(fake, method, params);
  assert.equal(response.error, undefined, `${method} failed: ${response.error?.message}`);
  return response.result;
}

test("executeCdp attaches implicitly, once, even under concurrency", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  const calls = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      ok(fake, "executeCdp", { ...S("s1"), target: { tabId: tab.id }, method: "Runtime.evaluate", commandParams: { expression: String(i) } })
    )
  );
  assert.equal(calls.length, 5);
  assert.deepEqual(fake.state.attachCalls, [tab.id], "exactly one chrome.debugger.attach");
});

test("executeCdp forwards target.sessionId to the flat child session", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  const result = await ok(fake, "executeCdp", {
    ...S("s1"),
    target: { tabId: tab.id, sessionId: "CHILD-1" },
    method: "Runtime.evaluate",
    commandParams: { expression: "1" }
  });
  assert.equal(result.sessionId, "CHILD-1");
  const last = fake.state.commands.at(-1);
  assert.deepEqual(last.target, { tabId: tab.id, sessionId: "CHILD-1" });
  const bad = await rpc(fake, "executeCdp", { ...S("s1"), target: { tabId: tab.id, sessionId: 7 }, method: "X.y" });
  assert.match(bad.error.message, /sessionId must be a string/);
});

test("executeCdp rejects tabs outside the session", async () => {
  const { fake } = await setup();
  const user = fake.userTab();
  const response = await rpc(fake, "executeCdp", { ...S("s1"), target: { tabId: user.id }, method: "Page.enable" });
  assert.match(response.error.message, /not part of browser session/);
  assert.deepEqual(fake.state.attachCalls, []);
});

test("CDP events carry sessionId; subscriptions filter domains; critical events always flow", async () => {
  const { fake } = await setup();
  const a = await ok(fake, "createTab", S("s1"));
  const b = await ok(fake, "createTab", S("s1"));
  // Unsubscribed tab → legacy broadcast.
  fake.chrome.debugger.onEvent.fire({ tabId: a.id, sessionId: "CHILD" }, "Network.requestWillBeSent", { requestId: "1" });
  let events = notifications(fake, "onCDPEvent");
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, "CHILD");
  assert.equal(events[0].subscribers, undefined);

  await ok(fake, "subscribe", { ...S("s1"), tabId: a.id, domains: ["Page"] });
  fake.chrome.debugger.onEvent.fire({ tabId: a.id }, "Network.requestWillBeSent", { requestId: "2" });
  fake.chrome.debugger.onEvent.fire({ tabId: a.id }, "Page.loadEventFired", {});
  fake.chrome.debugger.onEvent.fire({ tabId: a.id }, "Page.javascriptDialogOpening", { type: "alert" });
  fake.chrome.debugger.onEvent.fire({ tabId: a.id }, "Target.attachedToTarget", { sessionId: "C2" });
  fake.chrome.debugger.onEvent.fire({ tabId: b.id }, "Network.requestWillBeSent", { requestId: "3" });
  events = notifications(fake, "onCDPEvent").slice(1);
  assert.deepEqual(events.map((e) => e.method), [
    "Page.loadEventFired",
    "Page.javascriptDialogOpening",
    "Target.attachedToTarget",
    "Network.requestWillBeSent"
  ]);
  assert.deepEqual(events[0].subscribers, ["s1"]);
  assert.equal(events[3].source.tabId, b.id, "other tab still legacy-broadcast");

  await ok(fake, "unsubscribe", { ...S("s1"), tabId: a.id });
  fake.chrome.debugger.onEvent.fire({ tabId: a.id }, "Network.loadingFinished", {});
  assert.equal(notifications(fake, "onCDPEvent").at(-1).method, "Network.loadingFinished");
});

test("one group per root session, titled '<label> · OBU', muted colour; children share it but own their tabs", async () => {
  const { fake, bg } = await setup();
  const user = fake.userTab({ active: true });
  const rootTab = await ok(fake, "createTab", S("root", { label: "Research" }));
  const childTab = await ok(fake, "createTab", S("child", { parent_session_id: "root" }));
  const grandTab = await ok(fake, "createTab", S("grand", { parent_session_id: "child" }));
  const otherTab = await ok(fake, "createTab", S("other", { label: "Other" }));

  const groupOf = (id) => fake.state.tabs.get(id).groupId;
  assert.equal(groupOf(rootTab.id), groupOf(childTab.id));
  assert.equal(groupOf(rootTab.id), groupOf(grandTab.id));
  assert.notEqual(groupOf(rootTab.id), groupOf(otherTab.id));
  const group = fake.state.groups.get(groupOf(rootTab.id));
  assert.equal(group.title, "Research · OBU");
  assert.equal(group.color, bg.BRAND.groupColor);
  assert.equal(fake.state.groups.get(groupOf(otherTab.id)).title, "Other · OBU");

  const ids = async (sid) => (await ok(fake, "getTabs", S(sid))).map((t) => t.id).sort();
  assert.deepEqual(await ids("root"), [rootTab.id]);
  assert.deepEqual(await ids("child"), [childTab.id]);
  assert.deepEqual(await ids("grand"), [grandTab.id]);

  // Siblings/parents cannot drive each other's tabs.
  const denied = await rpc(fake, "executeCdp", { ...S("child"), target: { tabId: rootTab.id }, method: "Page.enable" });
  assert.match(denied.error.message, /not part of browser session child/);

  // Background only: never activated, user's tab untouched.
  assert.ok(fake.state.created.every((c) => c.active === false));
  assert.equal(fake.state.tabs.get(user.id).active, true);
});

test("concurrent createTab for 4 sessions × 2 tabs lands in exactly 4 groups", async () => {
  const { fake } = await setup();
  const sessions = ["a", "b", "c", "d"];
  const tabs = await Promise.all(
    sessions.flatMap((sid) => [ok(fake, "createTab", S(sid, { label: sid })), ok(fake, "createTab", S(sid, { label: sid }))])
  );
  assert.equal(fake.state.groups.size, 4);
  for (let i = 0; i < sessions.length; i += 1) {
    const [x, y] = [tabs[2 * i], tabs[2 * i + 1]];
    assert.equal(fake.state.tabs.get(x.id).groupId, fake.state.tabs.get(y.id).groupId);
  }
  assert.equal(notifications(fake, "leaseRevoked").length, 0, "own grouping is not a revoke");
});

test("createTab binds the last-focused window, opens url directly, reports targetId", async () => {
  const { fake } = await setup({
    windows: [
      { id: 1, focused: false, type: "normal" },
      { id: 2, focused: true, type: "normal" }
    ]
  });
  const tab = await ok(fake, "createTab", S("s1", { url: "https://example.com/" }));
  assert.equal(fake.state.tabs.get(tab.id).windowId, 2);
  assert.equal(tab.url, "https://example.com/");
  assert.equal(tab.targetId, `target-${tab.id}`);
  fake.focusWindow(1);
  const second = await ok(fake, "createTab", S("s1"));
  assert.equal(fake.state.tabs.get(second.id).windowId, 2, "stays in the bound window");
});

test("close guard: never close the tab the user is looking at", async () => {
  const { fake } = await setup();
  const viewed = await ok(fake, "createTab", S("s1"));
  const hidden = await ok(fake, "createTab", S("s1"));
  fake.activateTab(viewed.id);
  const closeViewed = await ok(fake, "closeTab", { ...S("s1"), tabId: viewed.id });
  assert.deepEqual(closeViewed, { closed: false, released: true, reason: "user_viewing" });
  assert.ok(fake.state.tabs.has(viewed.id));
  assert.equal(fake.state.tabs.get(viewed.id).groupId, -1);
  const closeHidden = await ok(fake, "closeTab", { ...S("s1"), tabId: hidden.id });
  assert.deepEqual(closeHidden, { closed: true, released: false });
  assert.ok(!fake.state.tabs.has(hidden.id));
  const again = await rpc(fake, "closeTab", { ...S("s1"), tabId: hidden.id });
  assert.equal(again.error.code, -32011);
  assert.equal(again.error.data.code, "tab_not_owned");
  await settle();
  assert.equal(notifications(fake, "leaseRevoked").length, 0);
});

test("finalizeTabs applies the close guard and reports dispositions", async () => {
  const { fake } = await setup();
  const viewed = await ok(fake, "createTab", S("s1"));
  const closable = await ok(fake, "createTab", S("s1"));
  const kept = await ok(fake, "createTab", S("s1"));
  fake.activateTab(viewed.id);
  const result = await ok(fake, "finalizeTabs", { ...S("s1"), keep: [{ tabId: kept.id, status: "handoff" }] });
  assert.deepEqual(result.closedTabIds, [closable.id]);
  assert.deepEqual(result.releasedTabIds, [viewed.id]);
  assert.deepEqual(result.keptTabIds, [kept.id]);
  assert.deepEqual(result.guardedTabs, [{ tabId: viewed.id, reason: "user_viewing" }]);
  await settle();
  assert.equal(notifications(fake, "leaseRevoked").length, 0, "own ungroup is not a revoke");
});

test("dragging an owned tab out of the group emits leaseRevoked and drops ownership", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  const started = Date.now();
  fake.dragOutOfGroup(tab.id);
  await settle(10);
  const [revoked] = notifications(fake, "leaseRevoked");
  assert.ok(revoked, "leaseRevoked emitted");
  assert.equal(revoked.tabId, tab.id);
  assert.equal(revoked.sessionId, "s1");
  assert.equal(revoked.reason, "group_exit");
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(await ok(fake, "getTabs", S("s1")), []);
});

test("closing an owned tab by hand emits tabClosed", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  await fake.chrome.tabs.remove(tab.id);
  await settle();
  assert.deepEqual(notifications(fake, "tabClosed"), [{ tabId: tab.id, sessionId: "s1" }]);
});

test("popups opened by a session tab are adopted into that session", async () => {
  const { fake } = await setup();
  const child = await ok(fake, "createTab", S("child", { parent_session_id: "root" }));
  const popup = await fake.chrome.tabs.create({ url: "https://popup.example/", windowId: 1, active: true, openerTabId: child.id });
  await settle();
  const [opened] = notifications(fake, "popupOpened");
  assert.deepEqual(opened, { tabId: popup.id, openerTabId: child.id, sessionId: "child", url: "https://popup.example/" });
  const tabs = (await ok(fake, "getTabs", S("child"))).map((t) => t.id).sort();
  assert.deepEqual(tabs, [child.id, popup.id].sort());
  // User tabs opening tabs are ignored.
  const user = fake.userTab();
  await fake.chrome.tabs.create({ url: "https://x/", windowId: 1, active: false, openerTabId: user.id });
  await settle();
  assert.equal(notifications(fake, "popupOpened").length, 1);
});

test("popup-window tabs that cannot be grouped are still owned and closable", async () => {
  const { fake } = await setup({
    windows: [
      { id: 1, focused: true, type: "normal" },
      { id: 9, focused: false, type: "popup" }
    ]
  });
  const opener = await ok(fake, "createTab", S("s1"));
  const popup = await fake.chrome.tabs.create({ url: "https://auth.example/", windowId: 9, active: true, openerTabId: opener.id });
  await settle();
  const tabs = (await ok(fake, "getTabs", S("s1"))).map((t) => t.id).sort();
  assert.deepEqual(tabs, [opener.id, popup.id].sort());
  const result = await ok(fake, "finalizeTabs", { ...S("s1"), keep: [] });
  assert.deepEqual(result.closedTabIds.sort(), [opener.id, popup.id].sort());
});

test("downloads are correlated to the tab via Page.downloadWillBegin", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  fake.chrome.debugger.onEvent.fire({ tabId: tab.id }, "Page.downloadWillBegin", {
    url: "https://files.example/report.pdf",
    guid: "g-1",
    suggestedFilename: "report.pdf"
  });
  fake.chrome.downloads.onCreated.fire({
    id: 42,
    url: "https://files.example/report.pdf",
    finalUrl: "https://files.example/report.pdf",
    referrer: "https://files.example/",
    startTime: "2026-10-15T00:00:00.000Z",
    filename: "",
    mime: "application/pdf"
  });
  await settle();
  const [started] = notifications(fake, "onDownloadChange");
  assert.equal(started.status, "started");
  assert.equal(started.tabId, tab.id);
  assert.equal(started.tabConfidence, "cdp");
  assert.equal(started.guid, "g-1");
  assert.equal(started.sessionId, "s1");
  assert.equal(started.referrer, "https://files.example/");
  assert.equal(started.startTime, "2026-10-15T00:00:00.000Z");
  fake.chrome.downloads.onChanged.fire({ id: 42, filename: { current: "/tmp/report.pdf" }, state: { current: "complete" } });
  const complete = notifications(fake, "onDownloadChange").at(-1);
  assert.equal(complete.status, "complete");
  assert.equal(complete.tabId, tab.id);
  assert.equal(complete.filename, "/tmp/report.pdf");
});

test("downloads fall back to referrer → session tab", async () => {
  const { fake } = await setup();
  const a = await ok(fake, "createTab", S("s1", { url: "https://a.example/page" }));
  await ok(fake, "createTab", S("s2", { url: "https://b.example/page" }));
  fake.chrome.downloads.onCreated.fire({ id: 7, url: "https://cdn.example/x.zip", referrer: "https://a.example/page", filename: "" });
  await settle();
  const [started] = notifications(fake, "onDownloadChange");
  assert.equal(started.tabId, a.id);
  assert.equal(started.tabConfidence, "referrer");
  assert.equal(started.sessionId, "s1");
});

test("route.profileId mismatch is rejected with profile_mismatch; match passes", async () => {
  const { fake } = await setup();
  const info = await ok(fake, "getInfo", {});
  assert.ok(info.metadata.profileId);
  assert.ok(info.capabilities.wire.includes("chunked-frames"));
  const bad = await rpc(fake, "createTab", { ...S("s1"), route: { profileId: "someone-else" } });
  assert.equal(bad.error.code, -32010);
  assert.equal(bad.error.data.code, "profile_mismatch");
  assert.equal(fake.state.tabs.size, 0);
  await ok(fake, "createTab", { ...S("s1"), route: { profileId: info.metadata.profileId } });
  assert.equal(fake.state.tabs.size, 1);
});

test("chunked host→extension frames are reassembled in any order; malformed frames dropped", async () => {
  const { fake } = await setup();
  const big = "y".repeat(2_500_000);
  const text = JSON.stringify({ jsonrpc: "2.0", id: "chunked-1", method: "ping", params: { pad: big } });
  const size = 900 * 1024;
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  const order = parts.map((_, i) => i).reverse();
  for (const i of order) fake.port.onMessage.fire({ chunk: { id: "m1", i, n: parts.length, data: parts[i] } });
  await settle();
  const response = fake.state.posted.find((message) => message.id === "chunked-1");
  assert.equal(response.result, "pong");
  fake.port.onMessage.fire({ chunk: { id: "bad", i: 3, n: 2, data: "" } });
  await settle();
  assert.equal(fake.state.posted.filter((m) => m.id === "bad").length, 0);
});

test("ChunkAssembler expires stale partial messages", async () => {
  const { bg } = await setup();
  let now = 0;
  const assembler = new bg.ChunkAssembler({ now: () => now, ttlMs: 100 });
  assert.equal(assembler.accept({ chunk: { id: "a", i: 0, n: 2, data: "{" } }), null);
  now = 500;
  assert.equal(assembler.accept({ chunk: { id: "b", i: 0, n: 1, data: "{\"ok\":1}" } }).ok, 1);
  assert.equal(assembler.pending.size, 0);
  assert.deepEqual(assembler.accept({ jsonrpc: "2.0", id: 1 }), { jsonrpc: "2.0", id: 1 });
});

test("large CDP results (5 MB) are returned whole", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  const result = await ok(fake, "executeCdp", { ...S("s1"), target: { tabId: tab.id }, method: "Runtime.evaluate", commandParams: { expression: "BIG" } });
  assert.equal(result.result.value.length, 5 * 1024 * 1024);
});

test("claiming another session's tab fails with tab_not_owned", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  const response = await rpc(fake, "claimUserTab", { ...S("s2"), tabId: tab.id });
  assert.equal(response.error.code, -32011);
  const user = fake.userTab();
  const claimed = await ok(fake, "claimUserTab", { ...S("s2"), tabId: user.id });
  assert.equal(claimed.id, user.id);
});

test("nameSession renames the root group with the brand suffix", async () => {
  const { fake } = await setup();
  const tab = await ok(fake, "createTab", S("s1"));
  await ok(fake, "nameSession", { ...S("s1"), name: "Flights" });
  assert.equal(fake.state.groups.get(fake.state.tabs.get(tab.id).groupId).title, "Flights · OBU");
});
