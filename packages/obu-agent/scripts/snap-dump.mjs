// Dev helper: print snapshots of golden pages (or URLs) with timings.
// Usage: node scripts/snap-dump.mjs [page.html|https://…] [--interactive]
import { launchChrome, startServer } from "../test/golden/harness.mjs";
import { takeSnapshot } from "../dist/snapshot/index.js";
const args = process.argv.slice(2);
const interactive = args.includes("--interactive");
const targets = args.filter((a) => !a.startsWith("--"));
const server = await startServer();
const browser = await launchChrome();
try {
  for (const t of targets) {
    const url = /^https?:/.test(t) ? t : `${server.base}/${t}`;
    const p = await browser.newPage(url);
    const t0 = performance.now();
    const s = await takeSnapshot(p.page, { interactive, maxChars: Number(process.env.MAXCHARS ?? 40000) });
    const ms = performance.now() - t0;
    console.log(`=== ${t} (${ms.toFixed(1)} ms, ${s.tree.length} chars, ${s.refCount} refs) warnings=${JSON.stringify(s.warnings)}`);
    console.log(s.tree);
    await p.close();
  }
} finally {
  await browser.close();
  server.close();
}
