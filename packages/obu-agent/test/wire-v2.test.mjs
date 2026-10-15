// r2-integrate: the daemon over an extension speaking wire v2 (WIRE.md):
// feature detection, route.profileId, closeTab RPC, no polling, and
// debuggerAttached/Detached, tabClosed, leaseRevoked, popupOpened,
// sessionExpired and onDownloadChange notifications → SystemEvents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { ObuHostBackend, Daemon, openStore } from "../dist/index.js";

const WIRE = ["cdp-child-sessions", "implicit-attach", "subscribe", "chunked-frames", "route", "lease-events", "popup-adoption", "download-correlation", "close-guard"];

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const out = Buffer.alloc(4 + payload.length);
  if (endianness() === "LE") out.writeUInt32LE(payload.length, 0);
  else out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

async function v2Relay(dir) {
  const frames = [];
  const tabs = new Map();
  let nextTab = 700;
  let peer;
  const server = createServer((socket) => {
    peer = socket;
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = endianness() === "LE" ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
        buf = buf.subarray(4 + len);
        frames.push(msg);
        if (msg.auth) continue;
        const reply = (result) => socket.write(frame({ jsonrpc: "2.0", id: msg.id, result }));
        const p = msg.params ?? {};
        switch (msg.method) {
          case "getInfo": reply({ version: "2.0.0", capabilities: { wire: WIRE }, metadata: { profileId: "prof-1" } }); break;
          case "createTab": { const id = nextTab++; tabs.set(id, { session: p.session_id, url: p.url ?? "about:blank" }); reply({ id, url: "about:blank", title: "", active: true, targetId: `T${id}` }); break; }
          case "nameSession": case "attach": case "finalizeTabs": reply(null); break;
          case "closeTab": tabs.delete(p.tabId); reply({ closed: true, released: false }); break;
          case "getTabs": reply([...tabs].filter(([, t]) => t.session === p.session_id).map(([id, t]) => ({ id, url: t.url, title: "", active: false }))); break;
          case "getUserTabs": reply([...tabs].map(([id, t]) => ({ id, url: t.url, title: "" }))); break;
          case "executeCdp": {
            const { method, commandParams, target } = p;
            if (method === "Page.getFrameTree") reply({ frameTree: { frame: { id: `F${target.tabId}`, url: tabs.get(target.tabId)?.url ?? "" } } });
            else if (method === "Page.createIsolatedWorld") reply({ executionContextId: 7 });
            else if (method === "Page.navigate") { tabs.get(target.tabId).url = commandParams.url; reply({ frameId: "F", loaderId: "L" }); setTimeout(() => socket.write(frame({ jsonrpc: "2.0", method: "onCDPEvent", params: { source: { tabId: target.tabId }, method: "Page.loadEventFired", params: {} } })), 5); }
            else if (method === "Runtime.evaluate") reply({ result: { value: [tabs.get(target.tabId)?.url, "T"] } });
            else reply({});
            break;
          }
          default: socket.write(frame({ jsonrpc: "2.0", id: msg.id, error: { message: `unknown ${msg.method}` } }));
        }
      }
    });
  });
  const socketPath = join(dir, "relay.sock");
  await new Promise((r) => server.listen(socketPath, r));
  writeFileSync(join(dir, "relay.token"), "tok\n");
  return { server, socketPath, frames, tabs, notify: (method, params) => peer.write(frame({ jsonrpc: "2.0", method, params })) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "obu-r2-wire-"));
  const relay = await v2Relay(dir);
  const backend = new ObuHostBackend({ socketPath: relay.socketPath });
  const daemon = new Daemon({
    profile: "Default",
    backend,
    store: openStore(":memory:"),
    artifactRoot: join(dir, "art"),
    sweepMs: 60_000,
    bundle: { source: "", version: "test" },
    modules: {
      takeSnapshot: async (_page, params) => ({ tree: "- t", diff: "", url: "u", title: "t", tabId: params.tabId, refCount: 0, warnings: [] }),
      performActionAndWait: async (_page, action) => { await action(); return { kind: "nav", ms: 1 }; },
    },
  });
  await daemon.start();
  const h = daemon.handlers();
  const call = (method, params) => h[method](params, { connectionId: 1 });
  const cleanup = async () => { await daemon.stop(); relay.server.close(); };
  return { relay, backend, daemon, call, cleanup };
}

test("wire v2: capabilities detected, route.profileId sent, closeTab RPC, no tab polling", async () => {
  const { relay, backend, call, cleanup } = await setup();
  try {
    assert.deepEqual(backend.capabilities(), { tabEvents: true, downloads: true, closeTab: true });
    await call("session.open", { sessionId: "s1", label: "job" });
    const opened = await call("tabs.open", { sessionId: "s1", url: "https://example.test/" });
    assert.equal(opened.targetId, `T${opened.tabId}`);
    const create = relay.frames.find((f) => f.method === "createTab");
    assert.deepEqual(create.params.route, { profileId: "prof-1" });
    assert.equal(create.params.label, "job");
    await call("tabs.close", { sessionId: "s1", tabId: opened.tabId });
    assert.ok(relay.frames.some((f) => f.method === "closeTab" && f.params.tabId === opened.tabId), "closeTab RPC used");
    assert.ok(!relay.frames.some((f) => f.method === "executeCdp" && f.params.method === "Page.close"), "no Page.close fallback");
    const before = relay.frames.filter((f) => f.method === "getTabs").length;
    await sleep(3_300);
    assert.equal(relay.frames.filter((f) => f.method === "getTabs").length, before, "no getTabs polling with lease-events");
  } finally {
    await cleanup();
  }
});

test("wire v2: notifications become SystemEvents for the owning session", async () => {
  const { relay, call, cleanup } = await setup();
  try {
    await call("session.open", { sessionId: "s2" });
    const a = await call("tabs.open", { sessionId: "s2", url: "https://a.test/" });
    const b = await call("tabs.open", { sessionId: "s2", url: "https://b.test/" });
    const c = await call("tabs.open", { sessionId: "s2", url: "https://c.test/" });

    relay.notify("popupOpened", { tabId: 900, openerTabId: a.tabId, sessionId: "obu-agent:s2", url: "https://popup.test/" });
    relay.notify("tabClosed", { tabId: b.tabId, sessionId: "obu-agent:s2" });
    relay.notify("leaseRevoked", { tabId: c.tabId, sessionId: "obu-agent:s2", reason: "group_exit", groupId: 3 });
    relay.notify("onDownloadChange", { id: "41", filename: "", url: "https://a.test/f.csv", status: "started", tabId: a.tabId, tabConfidence: "cdp" });
    relay.notify("onDownloadChange", { id: "41", filename: "/Users/x/Downloads/f.csv", url: "https://a.test/f.csv", status: "complete", tabId: a.tabId, tabConfidence: "cdp", mime: "text/csv", totalBytes: 12 });
    await sleep(50);

    const { events } = await call("session.events", { sessionId: "s2", afterSeq: 0 });
    const types = events.map((e) => e.type);
    assert.ok(types.includes("popup_opened"), types.join());
    const closed = events.find((e) => e.type === "tab_closed");
    assert.equal(closed.tabId, b.tabId);
    const revoked = events.find((e) => e.type === "lease_revoked");
    assert.equal(revoked.reason, "dragged_out_of_group");
    const finished = events.find((e) => e.type === "download_finished");
    assert.equal(finished.download.path, "/Users/x/Downloads/f.csv");
    assert.equal(finished.download.state, "complete");
    assert.equal(finished.download.tabId, a.tabId);
    assert.equal(events.filter((e) => e.type === "download_started").length, 1);

    const mine = await call("tabs.list", { sessionId: "s2" });
    const ids = mine.tabs.map((t) => t.tabId).sort();
    assert.deepEqual(ids, [a.tabId, 900].sort(), "closed + revoked tabs dropped, popup adopted");

    // Extension lease backstop finalized the session behind our back.
    relay.notify("sessionExpired", { sessionId: "obu-agent:s2", closedTabIds: [a.tabId, 900] });
    await sleep(30);
    const after = await call("tabs.list", { sessionId: "s2" });
    assert.equal(after.tabs.length, 0);
    const { events: more } = await call("session.events", { sessionId: "s2", afterSeq: events.at(-1).seq });
    assert.ok(more.some((e) => e.type === "tab_closed" && e.reason === "lease_expired"));
  } finally {
    await cleanup();
  }
});

test("wire v2: debuggerDetached re-runs the attach sequence; child sessionId routed", async () => {
  const { relay, backend, call, cleanup } = await setup();
  try {
    await call("session.open", { sessionId: "s3" });
    const tab = await call("tabs.open", { sessionId: "s3", url: "https://a.test/" });
    const pageEnables = () => relay.frames.filter((f) => f.method === "executeCdp" && f.params.method === "Page.enable" && f.params.target.tabId === tab.tabId).length;
    relay.notify("debuggerAttached", { tabId: tab.tabId }); // late echo of setup's attach while idle → still a fresh state
    await sleep(20);
    const base = pageEnables();
    await call("evaluate", { sessionId: "s3", expression: "1" });
    const afterEcho = pageEnables();
    relay.notify("debuggerDetached", { tabId: tab.tabId, reason: "idle" });
    await sleep(20);
    await call("evaluate", { sessionId: "s3", expression: "1" });
    assert.equal(pageEnables(), afterEcho + 1, "idle detach → setup re-run on the next call");
    assert.ok(afterEcho >= base);
    // Top-level onCDPEvent.sessionId (flat child session) is honoured.
    const seen = [];
    const off = backend.onEvent((e) => { if (e.type === "cdp" && e.method === "Page.frameNavigated") seen.push(e.sessionId); });
    relay.notify("onCDPEvent", { source: { tabId: tab.tabId }, sessionId: "CHILD", method: "Page.frameNavigated", params: { frame: { id: "FX", parentId: `F${tab.tabId}`, url: "https://x.test/" } } });
    await sleep(20);
    off();
    assert.deepEqual(seen, ["CHILD"]);
  } finally {
    await cleanup();
  }
});

test("wait{for:'download'} returns a download that finished just before the call, once", async () => {
  const { relay, call, cleanup } = await setup();
  try {
    await call("session.open", { sessionId: "s4" });
    const tab = await call("tabs.open", { sessionId: "s4", url: "https://a.test/" });
    relay.notify("onDownloadChange", { id: "9", filename: "", url: "https://a.test/x.bin", status: "started", tabId: tab.tabId });
    relay.notify("onDownloadChange", { id: "9", filename: "/dl/x.bin", url: "https://a.test/x.bin", status: "complete", tabId: tab.tabId });
    await sleep(30);
    const first = await call("wait", { sessionId: "s4", for: "download", timeoutMs: 200 });
    assert.equal(first.ok, true);
    assert.equal(first.download.path, "/dl/x.bin");
    const second = await call("wait", { sessionId: "s4", for: "download", timeoutMs: 200 });
    assert.equal(second.ok, false, "the same download must not satisfy two waits");
  } finally {
    await cleanup();
  }
});
