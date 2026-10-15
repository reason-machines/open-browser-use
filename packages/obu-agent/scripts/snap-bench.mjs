// Bench: snapshot latency (p50/p95 over N runs) and size vs raw DOM text + AX dump.
// Usage: node scripts/snap-bench.mjs [N] page.html|https://… …
import { launchChrome, startServer } from "../test/golden/harness.mjs";
import { takeSnapshot } from "../dist/snapshot/index.js";
const args = process.argv.slice(2);
const N = /^\d+$/.test(args[0]) ? Number(args.shift()) : 20;
const server = await startServer();
const browser = await launchChrome();
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const rows = [];
try {
  for (const t of args) {
    const url = /^https?:/.test(t) ? t : `${server.base}/${t}`;
    const p = await browser.newPage(url);
    if (/^https?:/.test(t)) await new Promise((r) => setTimeout(r, 2500));
    const res = {};
    for (const mode of ["full", "interactive"]) {
      const times = [];
      let snap;
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        snap = await takeSnapshot(p.page, { interactive: mode === "interactive", maxChars: 10_000_000 });
        times.push(performance.now() - t0);
      }
      res[mode] = { p50: pct(times, 0.5), p95: pct(times, 0.95), chars: snap.tree.length, refs: snap.refCount, first: times[0] };
    }
    const innerText = (await p.evaluate("document.body ? document.body.innerText.length : 0")) ?? 0;
    const html = (await p.evaluate("document.documentElement.outerHTML.length")) ?? 0;
    let ax = 0;
    try {
      const { nodes } = await p.page.cdp.send("Accessibility.getFullAXTree", {}, { timeoutMs: 30000 });
      ax = JSON.stringify(nodes).length;
    } catch {}
    const nodes = await p.evaluate("document.getElementsByTagName('*').length");
    rows.push({ page: t, nodes, ...Object.fromEntries(Object.entries(res).flatMap(([m, r]) => [[`${m}_p50_ms`, +r.p50.toFixed(1)], [`${m}_p95_ms`, +r.p95.toFixed(1)], [`${m}_chars`, r.chars], [`${m}_refs`, r.refs]])), innerText_chars: innerText, html_chars: html, ax_json_chars: ax, ratio_vs_innerText_plus_ax: +(res.full.chars / (innerText + ax)).toFixed(3) });
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(JSON.stringify(rows, null, 1));
