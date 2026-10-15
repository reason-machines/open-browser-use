// Minimal native-messaging test host for live extension checks. Chrome spawns
// it; it relays native frames ⇄ NDJSON on a unix socket ($OBU_LIVE_SOCKET or
// the path in <this dir>/socket-path.txt) and splits host→extension messages
// larger than 900 KB into {chunk:{id,i,n,data}} frames, mirroring WS-B.
// Not shipped; used by live/run-live.mjs only.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOCKET = process.env.OBU_LIVE_SOCKET || fs.readFileSync(path.join(HERE, "socket-path.txt"), "utf8").trim();
const CHUNK_BYTES = 900 * 1024;
const clients = new Set();
let nextChunk = 1;

function writeFrame(object) {
  const text = JSON.stringify(object);
  const body = Buffer.from(text, "utf8");
  if (body.length > CHUNK_BYTES) {
    const id = `h${process.pid}-${nextChunk++}`;
    // Slice on characters (the extension joins strings) at ≤ CHUNK_BYTES/4 chars
    // so every slice stays under 1 MB even for 4-byte UTF-8.
    const step = Math.floor(CHUNK_BYTES / 4);
    const n = Math.ceil(text.length / step);
    for (let i = 0; i < n; i += 1) writeFrame({ chunk: { id, i, n, data: text.slice(i * step, (i + 1) * step) } });
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let pending = Buffer.alloc(0);
process.stdin.on("data", (data) => {
  pending = Buffer.concat([pending, data]);
  while (pending.length >= 4) {
    const length = pending.readUInt32LE(0);
    if (pending.length < 4 + length) break;
    const text = pending.subarray(4, 4 + length).toString("utf8");
    pending = pending.subarray(4 + length);
    for (const client of clients) client.write(`${text}\n`);
  }
});
process.stdin.on("end", () => process.exit(0));

try {
  fs.unlinkSync(SOCKET);
} catch {}
const server = net.createServer((socket) => {
  clients.add(socket);
  let buffered = "";
  socket.on("data", (data) => {
    buffered += data.toString("utf8");
    let index;
    while ((index = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (line.trim()) writeFrame(JSON.parse(line));
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});
server.listen(SOCKET);
