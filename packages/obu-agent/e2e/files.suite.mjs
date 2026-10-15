// Uploads (incl. without file-URL access), per-tab downloads, screenshots, evaluate worlds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pct, pendingAware, refOf } from "./lib/harness.mjs";

const e2e = pendingAware(test);
function tmpFile(ctx, name, content) { const p = join(ctx.env.tmp, name); writeFileSync(p, content); return p; }

e2e("upload: file input, hidden styled input (via label), multiple, drop zone, iframe input", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("upload");
  const tab = await ctx.open(s, "upload.html");
  const { tree } = await ctx.snap(tab);
  const a = tmpFile(ctx, "resume.txt", "RESUME-CONTENT-123"), b = tmpFile(ctx, "b.txt", "BBB"), c = tmpFile(ctx, "c.txt", "CCC");
  await ctx.act(tab, { action: "upload", ref: refOf(tree, /Resume/), files: [a] });
  const single = await ctx.until(tab, "__fx.state.single || null");
  assert.deepEqual([single[0].name, single[0].head], ["resume.txt", "RESUME-CONTENT-123"]);
  await ctx.act(tab, { action: "upload", ref: refOf(tree, /Choose avatar/), files: [b] });
  assert.equal((await ctx.until(tab, "__fx.state['hidden-input'] || null"))[0].name, "b.txt");
  await ctx.act(tab, { action: "upload", ref: refOf(tree, /Attachments/), files: [b, c] });
  assert.deepEqual((await ctx.until(tab, "__fx.state.multi || null")).map((f) => f.name), ["b.txt", "c.txt"]);
  await ctx.act(tab, { action: "upload", ref: refOf(tree, /region "Drop zone"|Drop files here/), files: [c] });
  assert.equal((await ctx.until(tab, "__fx.state.drop || null"))[0].head, "CCC");
  await ctx.act(tab, { action: "upload", ref: refOf(tree, /File in iframe/), files: [a] });
  assert.equal((await ctx.until(tab, "__fx.state.frame || null", Boolean, 4000))[0].name, "resume.txt");
  ctx.t.diagnostic(`file-URL access for the extension: ${ctx.env.fileUrlAccess ?? "unknown"}`);
});

e2e("downloads: concurrent downloads in two sessions resolve to the triggering tab", async (ctx) => {
  ctx.requireExtension();
  const [sa, sb] = [await ctx.session("dl-a"), await ctx.session("dl-b")];
  const [ta, tb] = [await ctx.open(sa, "download.html?tag=A"), await ctx.open(sb, "download.html?tag=B")];
  const run = async (s, tab, tag) => {
    const ref = refOf((await ctx.snap(tab)).tree, /link "Download slow\.bin/);
    const waiting = s.call("wait", { tabId: tab.tabId, for: "download", timeoutMs: 15_000 });
    await ctx.act(tab, { action: "click", ref, snapshot: "none" });
    const w = await waiting;
    assert.equal(w.ok, true);
    assert.equal(w.download.tabId, tab.tabId, `download attributed to tab ${tag}`);
    assert.equal(w.download.state, "complete");
    assert.ok(existsSync(w.download.path), w.download.path);
    assert.match(readFileSync(w.download.path, "utf8").slice(0, 80), new RegExp(`tag=${tag}`));
    assert.equal(statSync(w.download.path).size, 65536);
    return w.download;
  };
  const [da, db] = await Promise.all([run(sa, ta, "A"), run(sb, tb, "B")]);
  assert.notEqual(da.path, db.path);
});

e2e("downloads: download attribute, blob URL and Content-Disposition all reported", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("dl-kinds");
  const tab = await ctx.open(s, "download.html?tag=K");
  const { tree } = await ctx.snap(tab);
  for (const [re, name] of [[/link "Download report-q3\.csv/, "report-q3.csv"], [/link "Download via download attribute"/, "renamed.txt"], [/button "Generate blob download"/, "blob-K.txt"]]) {
    const waiting = s.call("wait", { tabId: tab.tabId, for: "download", timeoutMs: 10_000 });
    const r = await ctx.act(tab, { action: "click", ref: refOf(tree, re), snapshot: "none" });
    const w = await waiting;
    assert.ok(w.download.path.endsWith(name), `${name}: ${w.download.path}`);
    const evs = (r.events ?? []).map((e) => e.type);
    ctx.t.diagnostic(`${name}: events ${evs.join(",")}`);
  }
});

e2e("screenshot: background tab JPEG to file, <= 1280 px wide, always < 3 s (p50 < 400 ms)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("shot");
  const tab = await ctx.open(s, "form.html");
  const ms = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    const shot = await s.call("screenshot", { tabId: tab.tabId });
    ms.push(performance.now() - t0);
    assert.equal(shot.mime, "image/jpeg");
    assert.ok(existsSync(shot.path));
    assert.equal(readFileSync(shot.path).subarray(0, 2).toString("hex"), "ffd8", "JPEG magic");
    assert.ok(shot.width <= 1280 && shot.width > 0);
  }
  ctx.t.diagnostic(`bg screenshot p50=${pct(ms, 50).toFixed(0)} max=${Math.max(...ms).toFixed(0)} ms`);
  assert.ok(Math.max(...ms) < 3000);
  assert.ok(pct(ms, 50) < 400);
  const ann = await s.call("screenshot", { tabId: tab.tabId, annotate: true, format: "png" });
  assert.equal(ann.mime, "image/png");
  const ref = refOf((await ctx.snap(tab)).tree, /button "Create account"/);
  const el = await s.call("screenshot", { tabId: tab.tabId, ref });
  assert.ok(el.width < 600, "element screenshot is cropped");
  const tab2 = await ctx.open(s, "long-list.html");
  const full = await s.call("screenshot", { tabId: tab2.tabId, fullPage: true });
  assert.ok(full.height > 900, "full page taller than the viewport");
  // annotate must not leave overlays in the page
  assert.equal(await ctx.fx(tab, "document.querySelectorAll('[data-obu-annotation], .__obu_annotation').length"), 0);
});

e2e("evaluate: isolated world by default (page globals invisible), page world on request", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("eval");
  const tab = await ctx.open(s, "form.html");
  const iso = await s.call("evaluate", { tabId: tab.tabId, expression: "typeof window.__fx" });
  assert.equal(iso.value, "undefined");
  const page = await s.call("evaluate", { tabId: tab.tabId, expression: "typeof window.__fx", world: "page" });
  assert.equal(page.value, "object");
  const dom = await s.call("evaluate", { tabId: tab.tabId, expression: "document.title" });
  assert.equal(dom.value, "Form fixture", "isolated world still sees the DOM");
});
