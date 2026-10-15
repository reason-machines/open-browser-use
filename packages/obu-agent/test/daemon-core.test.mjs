// WS-C unit tests: sessions, leases (fake clock), reconcile, mutex, ownership,
// transfer, events, attach sequence invariants, auth, store, MCP proxy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { ObuError, ObuAgentClient, serveJsonRpc, openStore, sweepExpired, runMcpProxy, MCP_TOOL_DEFS, METHODS } from "../dist/index.js";
import { FakeBackend, FakeClock, makeDaemon, sleep } from "./daemon-helpers.mjs";

const isCode = (code) => (e) => e instanceof ObuError && e.code === code;

test("session.open is idempotent; parent must exist; profile is checked", async () => {
  const { call, daemon } = await makeDaemon();
  const a = await call("session.open", { sessionId: "a", label: "A" });
  assert.equal(a.leaseTtlMs, 60_000);
  assert.equal(a.heartbeatIntervalMs, 15_000);
  assert.deepEqual((await call("session.open", { sessionId: "a" })).tabs, []);
  await assert.rejects(call("session.open", { sessionId: "c", parentSessionId: "nope" }), isCode("unknown_session"));
  await assert.rejects(call("session.open", { sessionId: "d", profile: "Profile 9" }), isCode("profile_mismatch"));
  await call("session.open", { sessionId: "child", parentSessionId: "a" });
  await assert.rejects(call("session.open", { sessionId: "child", parentSessionId: "zzz" }), isCode("lease_conflict"));
  await assert.rejects(call("tabs.list", { sessionId: "never" }), isCode("unknown_session"));
  await daemon.stop();
});

test("I1: one active tab; page calls without tabId use it; select/close move it", async () => {
  const { call, backend, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "s" });
  await assert.rejects(call("snapshot", { sessionId: "s" }), isCode("no_active_tab"));
  const t1 = await call("tabs.open", { sessionId: "s", url: "https://one.test/" });
  assert.equal(t1.ok, true);
  assert.equal(t1.url, "https://one.test/");
  assert.equal(t1.targetId, `T${t1.tabId}`);
  const t2 = await call("tabs.open", { sessionId: "s", url: "https://two.test/", makeActive: false });
  let list = await call("tabs.list", { sessionId: "s" });
  assert.equal(list.activeTabId, t1.tabId);
  assert.equal(list.tabs.filter((t) => t.active).length, 1);
  assert.equal((await call("snapshot", { sessionId: "s" })).tabId, t1.tabId);
  await call("tabs.select", { sessionId: "s", tabId: t2.tabId });
  assert.equal((await call("snapshot", { sessionId: "s" })).tabId, t2.tabId);
  const closed = await call("tabs.close", { sessionId: "s", tabId: t2.tabId });
  assert.equal(closed.activeTabId, t1.tabId);
  assert.deepEqual(backend.closed, [t2.tabId]);
  list = await call("tabs.list", { sessionId: "s" });
  assert.deepEqual(list.tabs.map((t) => t.tabId), [t1.tabId]);
  assert.equal(list.tabs[0].url, "https://one.test/");
  await daemon.stop();
});

test("I2: tab_not_owned across sessions and between parent/child until tabs.transfer", async () => {
  const { call, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "p" });
  await call("session.open", { sessionId: "c", parentSessionId: "p" });
  await call("session.open", { sessionId: "other" });
  const { tabId } = await call("tabs.open", { sessionId: "p", url: "https://p.test/" });
  await assert.rejects(call("snapshot", { sessionId: "c", tabId }), (e) => isCode("tab_not_owned")(e) && /tabs\.transfer/.test(e.message));
  await assert.rejects(call("act", { sessionId: "other", tabId, action: "click", ref: "e1" }), isCode("tab_not_owned"));
  await assert.rejects(call("tabs.select", { sessionId: "c", tabId }), isCode("tab_not_owned"));
  await assert.rejects(call("tabs.transfer", { sessionId: "p", tabId, toSessionId: "other" }), isCode("invalid_params"));
  await assert.rejects(call("tabs.transfer", { sessionId: "c", tabId, toSessionId: "p" }), isCode("tab_not_owned"));
  const after = await call("tabs.transfer", { sessionId: "p", tabId, toSessionId: "c" });
  assert.equal(after.activeTabId, undefined);
  assert.equal((await call("snapshot", { sessionId: "c" })).tabId, tabId, "child's active tab is the transferred one");
  await assert.rejects(call("snapshot", { sessionId: "p", tabId }), isCode("tab_not_owned"));
  const tree = await call("tabs.list", { sessionId: "p", scope: "mine+children" });
  assert.deepEqual(tree.tabs.map((t) => [t.tabId, t.sessionId]), [[tabId, "c"]]);
  await daemon.stop();
});

test("I3: per-tab mutex — same tab serialised, different tabs parallel", async () => {
  const act = async () => { await sleep(150); return { ok: true, settled: { kind: "dom", ms: 150 } }; };
  const { call, daemon } = await makeDaemon({ modules: { act } });
  await call("session.open", { sessionId: "a" });
  await call("session.open", { sessionId: "b" });
  const ta = await call("tabs.open", { sessionId: "a", url: "https://a.test/" });
  const tb = await call("tabs.open", { sessionId: "b", url: "https://b.test/" });
  let t0 = Date.now();
  await Promise.all([
    call("act", { sessionId: "a", action: "click", ref: "e1", snapshot: "none" }),
    call("act", { sessionId: "b", action: "click", ref: "e1", snapshot: "none" }),
  ]);
  const parallel = Date.now() - t0;
  t0 = Date.now();
  await Promise.all([
    call("act", { sessionId: "a", tabId: ta.tabId, action: "click", ref: "e1", snapshot: "none" }),
    call("act", { sessionId: "a", tabId: ta.tabId, action: "click", ref: "e2", snapshot: "none" }),
  ]);
  const serial = Date.now() - t0;
  assert.ok(parallel < 280, `different tabs should overlap (took ${parallel} ms)`);
  assert.ok(serial >= 290, `same tab should serialise (took ${serial} ms)`);
  assert.notEqual(ta.tabId, tb.tabId);
  await daemon.stop();
});

test("I4: lease expiry (fake clock) closes owned tabs, releases borrowed, child orphans reach the parent", async () => {
  const clock = new FakeClock();
  const { call, backend, daemon } = await makeDaemon({ clock });
  await call("session.open", { sessionId: "p" });
  await call("session.open", { sessionId: "c", parentSessionId: "p" });
  const userTab = backend.addUserTab("https://mail.test/");
  await call("tabs.attach", { sessionId: "c", tabId: userTab });
  const owned = await call("tabs.open", { sessionId: "c", url: "https://c.test/" });
  clock.advance(40_000);
  await call("session.heartbeat", { sessionId: "p" }); // parent stays alive
  clock.advance(25_000); // child: 65 s idle; parent: 25 s
  const swept = await sweepExpired(daemon.sessions);
  assert.deepEqual(swept, ["c"]);
  assert.deepEqual(backend.closed, [owned.tabId]);
  assert.deepEqual(backend.released, [userTab]);
  assert.ok(backend.tabs.has(userTab), "borrowed tab is never closed");
  const { events } = await call("session.events", { sessionId: "p" });
  assert.equal(events.at(-1).type, "orphans_closed");
  assert.deepEqual(events.at(-1).tabIds, [owned.tabId]);
  await assert.rejects(call("tabs.list", { sessionId: "c" }), isCode("unknown_session"));
  // Any call renews: the parent survives as long as it keeps calling.
  clock.advance(59_000);
  await call("tabs.list", { sessionId: "p" });
  clock.advance(59_000);
  assert.deepEqual(await sweepExpired(daemon.sessions), []);
  await daemon.stop();
});

test("session.close cascades to children, honours keep, finalizes the root owner", async () => {
  const { call, backend, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "root", label: "Research" });
  await call("session.open", { sessionId: "kid", parentSessionId: "root" });
  const a = await call("tabs.open", { sessionId: "root", url: "https://a.test/" });
  const b = await call("tabs.open", { sessionId: "root", url: "https://b.test/" });
  const k = await call("tabs.open", { sessionId: "kid", url: "https://k.test/" });
  await assert.rejects(call("session.close", { sessionId: "root", keep: [{ tabId: k.tabId, status: "handoff" }] }), isCode("tab_not_owned"));
  const result = await call("session.close", { sessionId: "root", keep: [{ tabId: b.tabId, status: "deliverable" }] });
  assert.deepEqual(result.closedTabIds.sort(), [a.tabId, k.tabId].sort());
  assert.deepEqual(result.keptTabIds, [b.tabId]);
  assert.deepEqual(backend.finalized, [{ owner: "obu-agent:root", keep: [{ tabId: b.tabId, status: "deliverable" }] }]);
  await assert.rejects(call("tabs.list", { sessionId: "kid" }), isCode("unknown_session"));
  await daemon.stop();
});

test("I5: reconcile on start finalizes expired sessions from a previous run, keeps live leases, respects the close guard", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obu-wsc-store-"));
  const storePath = join(dir, "state.sqlite");
  const backend = new FakeBackend();
  const clock = new FakeClock();
  const first = await makeDaemon({ backend, clock, storePath });
  await first.call("session.open", { sessionId: "dead" });
  await first.call("session.open", { sessionId: "alive" });
  const t1 = await first.call("tabs.open", { sessionId: "dead", url: "https://x.test/" });
  const t2 = await first.call("tabs.open", { sessionId: "dead", url: "https://y.test/" });
  const t3 = await first.call("tabs.open", { sessionId: "alive", url: "https://z.test/" });
  // Simulate a crash: no session.close; store keeps state.
  first.daemon.sessions.store.close();
  backend.tabs.get(t2.tabId).active = true; // the user is looking at t2
  clock.advance(45_000);
  // "alive" was touched recently by its client before the crash.
  const second = await (async () => {
    const reopened = openStore(storePath);
    const row = reopened.getSession("alive");
    row.expiresAt = clock.now() + 30_000;
    reopened.upsertSession(row);
    reopened.close();
    clock.advance(20_000); // dead: 65 s old
    return makeDaemon({ backend, clock, storePath });
  })();
  assert.ok(backend.closed.includes(t1.tabId), "orphan tab closed");
  assert.ok(!backend.closed.includes(t2.tabId), "tab the user is viewing is left open");
  assert.ok(!backend.closed.includes(t3.tabId), "live lease survives a daemon restart");
  assert.deepEqual(second.daemon.sessions.list().map((r) => r.id), ["alive"]);
  assert.deepEqual((await second.call("tabs.list", { sessionId: "alive" })).tabs.map((t) => t.tabId), [t3.tabId]);
  await second.daemon.stop();
});

test("events: dialog + navigation are appended once to the next result and stream via session.events with seq", async () => {
  const { call, backend, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "s" });
  const { tabId } = await call("tabs.open", { sessionId: "s", url: "https://d.test/" });
  const waiting = call("session.events", { sessionId: "s", afterSeq: 0, waitMs: 5_000 });
  await sleep(20);
  backend.emit({ type: "cdp", tabId, method: "Page.javascriptDialogOpening", params: { type: "alert", message: "hi" } });
  const polled = await waiting;
  await sleep(10);
  assert.equal(polled.events[0].type, "dialog");
  assert.equal(polled.events[0].action, "accepted");
  assert.ok(backend.log.some(([id, m, p]) => id === tabId && m === "Page.handleJavaScriptDialog" && p.accept === true));
  backend.emit({ type: "cdp", tabId, method: "Page.javascriptDialogOpening", params: { type: "prompt", message: "name?" } });
  await sleep(10);
  const snap = await call("snapshot", { sessionId: "s" });
  assert.deepEqual(snap.events.map((e) => [e.type, e.dialogType, e.action]), [["dialog", "prompt", "dismissed"]]);
  assert.equal((await call("snapshot", { sessionId: "s" })).events.length, 0, "delivered once");
  const all = await call("session.events", { sessionId: "s", afterSeq: 0 });
  assert.deepEqual(all.events.map((e) => e.seq), [1, 2]);
  assert.equal(all.lastSeq, 2);
  // wait{dialog} with an explicit decision answers the next dialog.
  const answered = call("wait", { sessionId: "s", for: "dialog", dialogAction: { accept: true, promptText: "Ada" }, timeoutMs: 2_000 });
  await sleep(20);
  backend.emit({ type: "cdp", tabId, method: "Page.javascriptDialogOpening", params: { type: "prompt", message: "name?" } });
  const waited = await answered;
  assert.equal(waited.ok, true);
  assert.equal(waited.event.action, "accepted");
  assert.ok(backend.log.some(([, m, p]) => m === "Page.handleJavaScriptDialog" && p.promptText === "Ada"));
  // Unexpected navigation outside a call -> [system] navigation event.
  backend.emit({ type: "cdp", tabId, method: "Page.frameNavigated", params: { frame: { id: `F${tabId}`, url: "https://elsewhere.test/" } } });
  const nav = await call("evaluate", { sessionId: "s", expression: "1" });
  assert.deepEqual(nav.events.map((e) => [e.type, e.url]).at(-1), ["navigation", "https://elsewhere.test/"]);
  await daemon.stop();
});

test("user closes / drags out a tab -> tab_closed / lease_revoked; popup adopted by the opener's session", async () => {
  const { call, backend, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "s" });
  const a = await call("tabs.open", { sessionId: "s", url: "https://a.test/" });
  const b = await call("tabs.open", { sessionId: "s", url: "https://b.test/" });
  backend.emit({ type: "popup", tabId: 999, openerTabId: b.tabId, url: "https://oauth.test/" });
  backend.tabs.set(999, { tabId: 999, url: "https://oauth.test/", title: "" });
  backend.emit({ type: "tab_closed", tabId: b.tabId });
  backend.emit({ type: "lease_revoked", tabId: a.tabId, reason: "dragged_out_of_group" });
  const { events } = await call("session.events", { sessionId: "s" });
  assert.deepEqual(events.map((e) => e.type), ["popup_opened", "tab_closed", "lease_revoked"]);
  assert.equal(events[0].tab.tabId, 999);
  assert.equal(events[1].reason, "user");
  const list = await call("tabs.list", { sessionId: "s" });
  assert.deepEqual(list.tabs.map((t) => t.tabId), [999]);
  assert.equal(list.activeTabId, 999);
  await daemon.stop();
});

test("I6/I7/I8: attach sequence, owned-only metrics override, focus only during act/navigate/snapshot, Runtime.enable never sent", async () => {
  const { call, backend, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "s" });
  const { tabId } = await call("tabs.open", { sessionId: "s", url: "https://o.test/" });
  const owned = backend.methods(tabId);
  for (const m of ["Page.enable", "Network.enable", "Page.setWebLifecycleState", "Emulation.setDeviceMetricsOverride", "Target.setAutoAttach"]) assert.ok(owned.includes(m), m);
  const metrics = backend.log.find(([id, m]) => id === tabId && m === "Emulation.setDeviceMetricsOverride")[2];
  assert.deepEqual([metrics.width, metrics.height, metrics.deviceScaleFactor], [1440, 900, 0]);
  const user = backend.addUserTab("https://u.test/");
  await call("tabs.attach", { sessionId: "s", tabId: user });
  await call("evaluate", { sessionId: "s", expression: "1" });
  assert.ok(!backend.methods(user).includes("Emulation.setDeviceMetricsOverride"), "borrowed tabs: no metrics override");
  assert.ok(!backend.methods(user).includes("Emulation.setFocusEmulationEnabled"), "evaluate does not emulate focus");
  backend.log.length = 0;
  await call("act", { sessionId: "s", tabId, action: "click", ref: "e1" });
  const focus = backend.log.filter(([, m]) => m === "Emulation.setFocusEmulationEnabled").map(([, , p]) => p.enabled);
  assert.deepEqual(focus, [true, false]);
  await assert.rejects(call("cdp", { sessionId: "s", method: "Runtime.enable" }), isCode("cdp_denied"));
  await assert.rejects(call("cdp", { sessionId: "s", method: "Target.closeTarget", params: {} }), isCode("cdp_denied"));
  const r = await call("cdp", { sessionId: "s", method: "Page.getFrameTree" });
  assert.ok(r.result.frameTree);
  assert.ok(!backend.log.some(([, m]) => m === "Runtime.enable" || m === "Debugger.enable"));
  await daemon.stop();
});

test("act returns a snapshot diff by default (tree on first), none/tree honoured; module errors become warnings", async () => {
  let n = 0;
  const takeSnapshot = async (page, params) => {
    n++;
    if (n === 3) throw new Error("boom");
    return { tree: `tree${n}`, diff: page.previousTree ? `diff-from-${page.previousTree}` : "", url: "u", title: "t", tabId: params.tabId, refCount: 1, warnings: [] };
  };
  const { call, daemon } = await makeDaemon({ modules: { takeSnapshot } });
  await call("session.open", { sessionId: "s" });
  await call("tabs.open", { sessionId: "s", url: "https://a.test/" });
  const first = await call("act", { sessionId: "s", action: "click", ref: "e1" });
  assert.equal(first.snapshot.tree, "tree1");
  const second = await call("act", { sessionId: "s", action: "click", ref: "e1" });
  assert.equal(second.snapshot.diff, "diff-from-tree1");
  const third = await call("act", { sessionId: "s", action: "click", ref: "e1" });
  assert.equal(third.snapshot, undefined);
  assert.match(third.warnings.join(), /snapshot after action failed: boom/);
  const none = await call("act", { sessionId: "s", action: "click", ref: "e1", snapshot: "none" });
  assert.equal(none.snapshot, undefined);
  await daemon.stop();
});

test("wait for selector/text/url polls; times out with a warning", async () => {
  const { call, backend, daemon } = await makeDaemon();
  await call("session.open", { sessionId: "s" });
  const { tabId } = await call("tabs.open", { sessionId: "s", url: "https://a.test/" });
  setTimeout(() => (backend.tabs.get(tabId).evalValue = true), 250);
  const ok = await call("wait", { sessionId: "s", for: "text", text: "Done", timeoutMs: 3_000 });
  assert.equal(ok.ok, true);
  backend.tabs.get(tabId).evalValue = false;
  const no = await call("wait", { sessionId: "s", for: "selector", selector: "#x", timeoutMs: 300 });
  assert.equal(no.ok, false);
  assert.match(no.warnings[0], /not met/);
  await daemon.stop();
});

test("token auth: wrong token rejected, right token accepted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obu-wsc-auth-"));
  const path = join(dir, "agent.sock");
  const server = await serveJsonRpc(path, { "daemon.info": () => ({ ok: 1 }) }, { token: "s3cret" });
  try {
    await assert.rejects(new ObuAgentClient(path, { token: "wrong" }).call("daemon.info", {}), /unauthorized|closed/);
    const noToken = new ObuAgentClient(path);
    await assert.rejects(noToken.call("daemon.info", {}), /unauthorized|closed/);
    const good = new ObuAgentClient(path, { token: "s3cret" });
    assert.deepEqual(await good.call("daemon.info", {}), { ok: 1 });
    good.close();
  } finally {
    server.close();
  }
});

test("store: sqlite and json backends round-trip sessions + tabs + active flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "obu-wsc-st-"));
  for (const path of [join(dir, "s.sqlite"), ":memory:"]) {
    const store = openStore(path);
    store.upsertSession({ id: "a", parent: null, label: "L", profile: "Default", heartbeatAt: 1, expiresAt: 2 });
    store.putTab({ sessionId: "a", tabId: 7, targetId: "T", ownership: "owned", active: false });
    store.putTab({ sessionId: "a", tabId: 8, targetId: null, ownership: "borrowed", active: false });
    store.setActive("a", 8);
    assert.deepEqual(store.tabsOf("a").map((t) => [t.tabId, t.active, t.ownership]), [[7, false, "owned"], [8, true, "borrowed"]]);
    assert.equal(store.ownerOf(7).sessionId, "a");
    store.deleteSession("a");
    assert.equal(store.ownerOf(7), undefined);
    store.close();
  }
  process.env.OBU_AGENT_STORE = "json";
  try {
    const path = join(dir, "j.sqlite");
    const store = openStore(path);
    assert.equal(store.kind, "json");
    store.upsertSession({ id: "b", parent: null, label: null, profile: "Default", heartbeatAt: 1, expiresAt: 2 });
    const again = openStore(path);
    assert.equal(again.getSession("b").id, "b");
  } finally {
    delete process.env.OBU_AGENT_STORE;
  }
});

test("MCP proxy: initialize, static tools/list, tools/call with [system] lines, session closed on EOF", async () => {
  const { daemon, backend } = await makeDaemon();
  const dir = mkdtempSync(join(tmpdir(), "obu-wsc-mcp-"));
  const socketPath = join(dir, "agent.sock");
  const server = await serveJsonRpc(socketPath, daemon.handlers());
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcpProxy({ socketPath, sessionId: "mcp-1", label: "MCP", input, output, log: () => {} });
  const lines = createInterface({ input: output });
  const pending = new Map();
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: myId, method, params })}\n`);
  });
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.result.serverInfo.name, "obu-agent");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await rpc("tools/list", {});
  assert.equal(list.result.tools.length, MCP_TOOL_DEFS.length);
  for (const tool of list.result.tools) assert.equal(tool.inputSchema.type, "object");
  for (const def of MCP_TOOL_DEFS) assert.ok(METHODS.includes(def.method));
  const opened = await rpc("tools/call", { name: "browser_tabs_open", arguments: { url: "https://m.test/" } });
  assert.equal(opened.result.isError, undefined);
  const tabId = JSON.parse(opened.result.content[0].text.split("\n")[0]).tabId;
  backend.emit({ type: "cdp", tabId, method: "Page.javascriptDialogOpening", params: { type: "alert", message: "boo" } });
  await sleep(10);
  const snap = await rpc("tools/call", { name: "browser_snapshot", arguments: {} });
  assert.match(snap.result.content[0].text, /\[system\] alert dialog accepted: "boo"/);
  const bad = await rpc("tools/call", { name: "browser_snapshot", arguments: { tabId: 424242 } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /not owned/);
  input.end();
  await done;
  assert.equal(daemon.sessions.get("mcp-1"), undefined, "session finalized when the MCP client goes away");
  assert.ok(backend.closed.includes(tabId));
  server.close();
  await daemon.stop();
});
