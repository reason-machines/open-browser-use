import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_VERSION, ERROR_CODES, METHODS, READ_ONLY_METHODS, CDP_DENYLIST_PREFIXES,
  ObuError, ObuAgentClient, createHandlers, serveJsonRpc, renderSystemEvent, KeyedMutex,
} from "../dist/index.js";
import { MCP_TOOLS } from "../dist/mcp/index.js";
import { ATTACH_SEQUENCE, FORBIDDEN_ON_AGENT_PAGES } from "../dist/cdp/index.js";

test("method table is unique and read-only set is a subset", () => {
  assert.equal(new Set(METHODS).size, METHODS.length);
  for (const m of READ_ONLY_METHODS) assert.ok(METHODS.includes(m), m);
  for (const m of Object.values(MCP_TOOLS)) assert.ok(METHODS.includes(m), m);
});

test("error codes are unique", () => {
  const codes = Object.values(ERROR_CODES);
  assert.equal(new Set(codes).size, codes.length);
});

test("attach sequence never enables Runtime/Debugger (I8)", () => {
  for (const forbidden of FORBIDDEN_ON_AGENT_PAGES) assert.ok(!ATTACH_SEQUENCE.includes(forbidden));
  assert.ok(CDP_DENYLIST_PREFIXES.includes("Runtime.enable"));
});

test("system events render as [system] lines", () => {
  const line = renderSystemEvent({ seq: 1, at: 0, sessionId: "s", tabId: 3, type: "dialog", dialogType: "alert", message: "hi", action: "accepted" });
  assert.match(line, /^\[system\] alert dialog accepted/);
});

test("keyed mutex serialises same key, parallelises different keys", async () => {
  const mutex = new KeyedMutex();
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  await Promise.all([
    mutex.run(1, async () => { order.push("a1"); await sleep(40); order.push("a2"); }),
    mutex.run(1, async () => { order.push("b1"); await sleep(40); order.push("b2"); }),
    mutex.run(2, async () => { await sleep(40); }),
  ]);
  assert.deepEqual(order, ["a1", "a2", "b1", "b2"]);
  assert.ok(Date.now() - t0 < 200);
  assert.equal(mutex.isLocked(1), false);
});

test("JSON-RPC server: daemon.info works, others return typed not_implemented", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obu-agent-"));
  const path = join(dir, "agent.sock");
  const server = await serveJsonRpc(path, createHandlers({ profile: "Default", startedAt: 1 }));
  const client = new ObuAgentClient(path);
  try {
    const info = await client.call("daemon.info", {});
    assert.equal(info.contractVersion, CONTRACT_VERSION);
    assert.equal(info.profile, "Default");
    await assert.rejects(client.call("snapshot", { sessionId: "s" }), (e) => e instanceof ObuError && e.code === "not_implemented" && /WS-D/.test(e.message));
    await assert.rejects(client.call("nope", {}), (e) => e instanceof ObuError && e.code === "method_not_found");
  } finally {
    client.close();
    server.close();
  }
});
