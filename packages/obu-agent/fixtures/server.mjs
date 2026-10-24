#!/usr/bin/env node
// Fixture site for e2e + bench (WS-G). Serves the same pages on two origins so
// cross-origin iframes become OOPIFs under site isolation:
//   http://localhost:<port>/  and  http://127.0.0.1:<port2>/
// Usage: node fixtures/server.mjs [--port 47110] [--port2 47111]
// Routes beyond static pages:
//   /config.js                      window.__FX_CONFIG = {origin, crossOrigin}
//   /download/file.txt?name=&bytes=&ms=&tag=   Content-Disposition attachment (optionally slow)
//   /slow?ms=2000                   delayed JSON
//   /api/items?page=N               infinite-scroll feed (10 pages x 20, needle in post 137)
//   /spa/<route>                    serves spa.html (deep links)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES } from "./pages.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "pages");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
export const NEEDLE_POST = 137;
export const NEEDLE_TEXT = "the quick brown fixture jumps over the lazy daemon";

function feedPage(page) {
  const items = [];
  for (let i = page * 20; i < Math.min(200, page * 20 + 20); i++) {
    items.push({ id: i, title: `Post ${i}`, body: i === NEEDLE_POST ? `Needle: ${NEEDLE_TEXT}` : `Ordinary post body number ${i}.` });
  }
  return { page, items, more: page < 9 };
}

function createHandler(config) {
  return function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://x");
    const q = url.searchParams;
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": types[".html"] });
      res.end(`<!doctype html><title>obu fixtures</title><h1>obu fixtures</h1><ul>${PAGES.map((p) => `<li><a href="/${p.file}">${p.file}</a> — ${p.covers}</li>`).join("")}</ul>`);
      return;
    }
    if (url.pathname === "/config.js") {
      res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
      res.end(`window.__FX_CONFIG=${JSON.stringify(config)};`);
      return;
    }
    if (url.pathname === "/download/file.txt") {
      const name = (q.get("name") ?? "obu-fixture.txt").replace(/[^\w.-]/g, "_");
      const tag = q.get("tag") ?? "";
      const bytes = Number(q.get("bytes") ?? 0);
      const head = `obu fixture download name=${name} tag=${tag}\n`;
      const body = bytes > head.length ? head + "x".repeat(bytes - head.length) : head;
      const send = () => { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": Buffer.byteLength(body), "content-disposition": `attachment; filename="${name}"` }); res.end(body); };
      const ms = Math.min(Number(q.get("ms") ?? 0), 60_000);
      if (ms > 0) setTimeout(send, ms); else send();
      return;
    }
    if (url.pathname === "/slow") {
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }, Math.min(Number(q.get("ms") ?? 2000), 60_000));
      return;
    }
    if (url.pathname === "/api/items") {
      const page = Math.max(0, Math.min(9, Number(q.get("page") ?? 0)));
      setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(feedPage(page))); }, 120);
      return;
    }
    const pathname = url.pathname.startsWith("/spa/") ? "/spa.html" : url.pathname;
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    readFile(file).then(
      (body) => { res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(body); },
      () => { res.writeHead(404); res.end("not found"); },
    );
  };
}

export async function startFixtures({ port = 0, port2 = 0 } = {}) {
  const config = { origin: "", crossOrigin: "" };
  const handler = createHandler(config);
  const a = createServer(handler);
  const b = createServer(handler);
  await new Promise((r, j) => { a.once("error", j); a.listen(port, "localhost", r); });
  await new Promise((r, j) => { b.once("error", j); b.listen(port2, "127.0.0.1", r); });
  config.origin = `http://localhost:${a.address().port}`;
  config.crossOrigin = `http://127.0.0.1:${b.address().port}`;
  return {
    origin: config.origin,
    crossOrigin: config.crossOrigin,
    url: (file) => `${config.origin}/${file}`,
    close: () => { a.closeAllConnections?.(); b.closeAllConnections?.(); return Promise.all([new Promise((r) => a.close(r)), new Promise((r) => b.close(r))]); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? Number(process.argv[i + 1]) : d; };
  const s = await startFixtures({ port: arg("port", 47110), port2: arg("port2", 47111) });
  console.log(JSON.stringify({ origin: s.origin, crossOrigin: s.crossOrigin }));
}
