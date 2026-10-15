import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { endianness } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChunkAssembler, OpenBrowserUseClient, encodeFrame, readRelayToken } from "../dist/index.js";

function frames(onMessage) {
  let pending = Buffer.alloc(0);
  return (data) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= 4) {
      const length = endianness() === "LE" ? pending.readUInt32LE(0) : pending.readUInt32BE(0);
      if (pending.length < 4 + length) return;
      onMessage(JSON.parse(pending.subarray(4, 4 + length).toString("utf8")));
      pending = pending.subarray(4 + length);
    }
  };
}

// Fake relay: requires {"auth":token} first (like internal/host with
// RequireToken), then answers each request with `respond(request)`.
async function fakeRelay(directory, { token, respond }) {
  const socketPath = join(directory, "obu.sock");
  const server = createServer((socket) => {
    let authed = !token;
    socket.on(
      "data",
      frames((message) => {
        if (!authed) {
          if (message.auth === token) {
            authed = true;
            return;
          }
          socket.end(encodeFrame({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized", data: { type: "unauthorized" } } }));
          return;
        }
        if (message.auth !== undefined) return;
        for (const frame of respond(message)) socket.write(frame);
      })
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Mirrors wire.SplitChunks: JSON-text slices on code point boundaries.
function splitChunks(text, id, size) {
  const parts = [];
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + size, text.length);
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end -= 1;
    parts.push(text.slice(at, end));
    at = end;
  }
  return parts.map((data, i) => encodeFrame({ chunk: { id, i, n: parts.length, data } }));
}

test("sends the relay token handshake and gets answers", async () => {
  const directory = await mkdtemp("/tmp/obu-js-auth-");
  const tokenPath = join(directory, "relay.token");
  await writeFile(tokenPath, "secret-token\n");
  await chmod(tokenPath, 0o600);
  const relay = await fakeRelay(directory, {
    token: "secret-token",
    respond: (m) => [encodeFrame({ jsonrpc: "2.0", id: m.id, result: { method: m.method } })]
  });
  const client = new OpenBrowserUseClient({ socketPath: relay.socketPath, timeoutMs: 2000 });
  try {
    assert.deepEqual(await client.getInfo(), { method: "getInfo" });
  } finally {
    client.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("OBU_RELAY_AUTH=uid skips the handshake; relay errors reject the request", async () => {
  const directory = await mkdtemp("/tmp/obu-js-uid-");
  const tokenPath = join(directory, "relay.token");
  await writeFile(tokenPath, "secret-token\n");
  await chmod(tokenPath, 0o600);
  const relay = await fakeRelay(directory, { token: "secret-token", respond: () => [] });
  process.env.OBU_RELAY_AUTH = "uid";
  const client = new OpenBrowserUseClient({ socketPath: relay.socketPath, timeoutMs: 2000 });
  try {
    assert.equal(readRelayToken(relay.socketPath), null);
    await assert.rejects(client.getInfo(), /unauthorized|socket closed/);
  } finally {
    delete process.env.OBU_RELAY_AUTH;
    client.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a group/world readable token file", async () => {
  const directory = await mkdtemp("/tmp/obu-js-perm-");
  const tokenPath = join(directory, "relay.token");
  await writeFile(tokenPath, "t\n");
  await chmod(tokenPath, 0o644);
  try {
    assert.throws(() => readRelayToken(join(directory, "obu.sock")), /0600/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reassembles chunked responses (WIRE.md text slices)", async () => {
  const directory = await mkdtemp("/tmp/obu-js-chunk-");
  const big = "漢🙂x\"\\".repeat(400_000);
  const relay = await fakeRelay(directory, {
    respond: (m) => splitChunks(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { big } }), `r${m.id}`, 300_000)
  });
  const client = new OpenBrowserUseClient({ socketPath: relay.socketPath, timeoutMs: 5000 });
  try {
    const result = await client.getInfo();
    assert.equal(result.big, big);
  } finally {
    client.close();
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ChunkAssembler passes through plain messages and rejects malformed chunks", () => {
  const assembler = new ChunkAssembler();
  assert.deepEqual(assembler.accept({ id: 1 }), { id: 1 });
  assert.throws(() => assembler.accept({ chunk: { id: "a", i: 3, n: 2, data: "" } }), /Malformed/);
  assert.equal(assembler.accept({ chunk: { id: "b", i: 1, n: 2, data: '1}' } }), null);
  assert.deepEqual(assembler.accept({ chunk: { id: "b", i: 0, n: 2, data: '{"x":' } }), { x: 1 });
});
