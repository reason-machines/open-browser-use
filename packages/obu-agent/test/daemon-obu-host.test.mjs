// WS-C: ObuHostBackend against a fake native-host relay (length-prefixed JSON,
// WS-B auth frame, onCDPEvent notifications), through the full daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { endianness, tmpdir } from "node:os";
import { join } from "node:path";
import { ObuHostBackend, Daemon, openStore } from "../dist/index.js";

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const out = Buffer.alloc(4 + payload.length);
  if (endianness() === "LE") out.writeUInt32LE(payload.length, 0);
  else out.writeUInt32BE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

async function fakeRelay(dir, { token = "relay-secret" } = {}) {
  const frames = [];
  const tabs = new Map(); // tabId -> {session, url}
  let nextTab = 500;
  let peer;
  const server = createServer((socket) => {
    peer = socket;
    let buf = Buffer.alloc(0);
    let authed = false;
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = endianness() === "LE" ? buf.readUInt32LE(0) : buf.readUInt32BE(0);
        if (buf.length < 4 + len) return;
        const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
        buf = buf.subarray(4 + len);
        frames.push(msg);
        if (!authed) {
          if (msg.auth !== token) {
            socket.write(frame({ id: null, error: { code: -32001, message: "unauthorized", data: { type: "unauthorized" } } }));
            socket.end();
            return;
          }
          authed = true;
          continue;
        }
        const reply = (result) => socket.write(frame({ jsonrpc: "2.0", id: msg.id, result }));
        const p = msg.params ?? {};
        switch (msg.method) {
          case "getInfo": reply({ version: "9.9.9" }); break;
          case "createTab": { const id = nextTab++; tabs.set(id, { session: p.session_id, url: "about:blank" }); reply({ id, url: "about:blank", title: "", active: true }); break; }
          case "nameSession": reply(null); break;
          case "attach": reply(null); break;
          case "getTabs": reply([...tabs].filter(([, t]) => t.session === p.session_id).map(([id, t]) => ({ id, url: t.url, title: "", active: false }))); break;
          case "getUserTabs": reply([...tabs].map(([id, t]) => ({ id, url: t.url, title: "" }))); break;
          case "finalizeTabs": reply(null); break;
          case "executeCdp": {
            const { method, commandParams, target } = p;
            if (method === "Page.getFrameTree") reply({ frameTree: { frame: { id: `F${target.tabId}`, url: tabs.get(target.tabId)?.url ?? "" } } });
            else if (method === "Page.createIsolatedWorld") reply({ executionContextId: 7 });
            else if (method === "Page.navigate") { tabs.get(target.tabId).url = commandParams.url; reply({ frameId: "F", loaderId: "L" }); setTimeout(() => socket.write(frame({ jsonrpc: "2.0", method: "onCDPEvent", params: { source: { tabId: target.tabId }, method: "Page.loadEventFired", params: {} } })), 5); }
            else if (method === "Page.close") { tabs.delete(target.tabId); reply({}); }
            else if (method === "Runtime.evaluate") reply({ result: { value: target.sessionId ? `child:${target.sessionId}` : [tabs.get(target.tabId)?.url, "T"] } });
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
  writeFileSync(join(dir, "relay.token"), `${token}\n`);
  return { server, socketPath, frames, tabs, notify: (method, params) => peer.write(frame({ jsonrpc: "2.0", method, params })) };
}

test("ObuHostBackend: auth frame first, root-session owner key, executeCdp routing, notifications", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obu-wsc-host-"));
  const relay = await fakeRelay(dir);
  const backend = new ObuHostBackend({ socketPath: relay.socketPath, pollMs: 0 });
  const daemon = new Daemon({ profile: "Default", backend, store: openStore(":memory:"), artifactRoot: dir, bundle: { source: "", version: "x" }, sweepMs: 60_000,
    modules: { performActionAndWait: async (_p, action) => { await action(); return { kind: "nav", ms: 0 }; } } });
  await daemon.start();
  const h = daemon.handlers();
  const call = (m, p) => h[m](p, { connectionId: 1 });
  try {
    assert.deepEqual(relay.frames[0], { auth: "relay-secret" }, "auth is the first frame");
    assert.equal((await call("daemon.info", {})).extension.version, "9.9.9");
    await call("session.open", { sessionId: "root", label: "Root" });
    await call("session.open", { sessionId: "kid", parentSessionId: "root" });
    const opened = await call("tabs.open", { sessionId: "kid", url: "https://k.test/" });
    assert.equal(opened.url, "https://k.test/");
    const create = relay.frames.find((f) => f.method === "createTab");
    assert.equal(create.params.session_id, "obu-agent:root", "children share the root's extension session (one group per root)");
    const nav = relay.frames.find((f) => f.method === "executeCdp" && f.params.method === "Page.navigate");
    assert.deepEqual(nav.params.target, { tabId: opened.tabId });
    assert.ok(nav.params.timeoutMs > 0, "timeoutMs passed through for the relay");
    assert.ok(!relay.frames.some((f) => f.params?.method === "Runtime.enable"));
    // OOPIF child session routing: events with source.sessionId, commands with target.sessionId.
    relay.notify("onCDPEvent", { source: { tabId: opened.tabId }, method: "Target.attachedToTarget", params: { sessionId: "CHILD1", targetInfo: { type: "iframe", targetId: "IF1", url: "https://x/" } } });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(relay.frames.some((f) => f.params?.method === "Page.enable" && f.params.target.sessionId === "CHILD1"), "child session set up via target.sessionId");
    // Notifications from the WS-A extension.
    relay.notify("popupOpened", { tabId: 777, openerTabId: opened.tabId, url: "https://pop/" });
    relay.notify("onCDPEvent", { source: { tabId: opened.tabId }, method: "Page.javascriptDialogOpening", params: { type: "alert", message: "x" } });
    await new Promise((r) => setTimeout(r, 30));
    const ev = await call("session.events", { sessionId: "kid" });
    assert.deepEqual(ev.events.map((e) => e.type), ["popup_opened", "dialog"]);
    relay.notify("leaseRevoked", { tabId: 777, reason: "dragged_out_of_group" });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await call("session.events", { sessionId: "kid", afterSeq: 2 })).events[0].type, "lease_revoked");
    const closed = await call("session.close", { sessionId: "root" });
    assert.deepEqual(closed.closedTabIds, [opened.tabId]);
    assert.ok(relay.frames.some((f) => f.params?.method === "Page.close"));
    assert.equal(relay.frames.filter((f) => f.method === "finalizeTabs").at(-1).params.session_id, "obu-agent:root");
  } finally {
    await daemon.stop();
    relay.server.close();
  }
});

test("ObuHostBackend: wrong relay token -> disconnected, typed extension_disconnected errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obu-wsc-host2-"));
  const relay = await fakeRelay(dir, { token: "right" });
  writeFileSync(join(dir, "wrong.token"), "nope\n");
  const backend = new ObuHostBackend({ socketPath: relay.socketPath, tokenPath: join(dir, "wrong.token"), pollMs: 0, defaultTimeoutMs: 500 });
  await backend.connect().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(backend.isConnected(), false);
  await assert.rejects(backend.createTab({ key: "k" }, "about:blank"), (e) => e.code === "extension_disconnected");
  relay.server.close();
});
