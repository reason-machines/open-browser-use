#!/usr/bin/env node
// Fixture site for e2e + bench (WS-G fills pages/). Serves the same pages on two
// origins so cross-origin iframes become OOPIFs under site isolation:
//   http://localhost:<port>/  and  http://127.0.0.1:<port2>/
// Usage: node fixtures/server.mjs [--port 47110] [--port2 47111]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES } from "./pages.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "pages");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain" };

function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": types[".html"] });
    res.end(`<!doctype html><title>obu fixtures</title><ul>${PAGES.map((p) => `<li><a href="/${p.file}">${p.file}</a> — ${p.covers}</li>`).join("")}</ul>`);
    return;
  }
  if (url.pathname === "/download/file.txt") {
    res.writeHead(200, { "content-type": "text/plain", "content-disposition": 'attachment; filename="obu-fixture.txt"' });
    res.end("obu fixture download\n");
    return;
  }
  if (url.pathname === "/slow") {
    setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }, Number(url.searchParams.get("ms") ?? 2000));
    return;
  }
  const file = normalize(join(root, url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
  readFile(file).then(
    (body) => { res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }); res.end(body); },
    () => { res.writeHead(404); res.end("not found"); },
  );
}

export async function startFixtures({ port = 0, port2 = 0 } = {}) {
  const a = createServer(handler);
  const b = createServer(handler);
  await new Promise((r) => a.listen(port, "localhost", r));
  await new Promise((r) => b.listen(port2, "127.0.0.1", r));
  return {
    origin: `http://localhost:${a.address().port}`,
    crossOrigin: `http://127.0.0.1:${b.address().port}`,
    close: () => Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
  const s = await startFixtures({ port: arg("port", 47110), port2: arg("port2", 47111) });
  console.log(JSON.stringify({ origin: s.origin, crossOrigin: s.crossOrigin }));
}
