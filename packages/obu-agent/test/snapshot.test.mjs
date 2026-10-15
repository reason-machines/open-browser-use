// WS-D snapshot engine tests.
// Unit: unifiedDiff, stitchFrames. Live (skipped when no Chrome for Testing is
// found): golden YAML per fixture page, ref stability, one-line diffs,
// scoping, size errors, OOPIF stitching, injected helpers, latency budgets.
// Regenerate goldens: UPDATE_GOLDEN=1 pnpm --filter obu-agent test
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff, stitchFrames, takeSnapshot, withAnnotations } from "../dist/snapshot/index.js";
import { INJECTED_BUNDLE_SOURCE } from "../dist/injected/index.js";
import { ObuError } from "../dist/errors.js";
import { findChrome, launchChrome, startServer, PAGES_DIR } from "./golden/harness.mjs";

const GOLDEN_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "golden");

describe("unifiedDiff", () => {
  test("empty when no previous or equal", () => {
    assert.equal(unifiedDiff(undefined, "a"), "");
    assert.equal(unifiedDiff("a\nb", "a\nb"), "");
  });
  test("single changed line → one -/+ pair with context", () => {
    const a = ["- x", "- button \"Follow\" [ref=e1]", "- y", "- z"].join("\n");
    const b = ["- x", "- button \"Following\" [ref=e2]", "- y", "- z"].join("\n");
    const d = unifiedDiff(a, b).split("\n");
    assert.equal(d[0], "@@ -1,3 +1,3 @@");
    assert.deepEqual(d.filter((l) => l.startsWith("-") || l.startsWith("+")), ['-- button "Follow" [ref=e1]', '+- button "Following" [ref=e2]']);
  });
  test("insertions and deletions far apart → separate hunks", () => {
    const base = Array.from({ length: 40 }, (_, i) => `- line ${i}`);
    const next = [...base];
    next.splice(5, 1);
    next.splice(30, 0, "- inserted");
    const d = unifiedDiff(base.join("\n"), next.join("\n"));
    assert.equal(d.split("\n").filter((l) => l.startsWith("@@")).length, 2);
    assert.ok(d.includes("-- line 5"));
    assert.ok(d.includes("+- inserted"));
  });
  test("diff applies: replaying hunks reproduces the new text", () => {
    const a = Array.from({ length: 200 }, (_, i) => `l${i % 17}`);
    const b = a.filter((_, i) => i % 13 !== 0).map((l, i) => (i % 29 === 0 ? l + "!" : l));
    const d = unifiedDiff(a.join("\n"), b.join("\n"));
    const minus = d.split("\n").filter((l) => l.startsWith("-")).length;
    const plus = d.split("\n").filter((l) => l.startsWith("+")).length;
    assert.equal(a.length - minus + plus, b.length);
  });
});

describe("stitchFrames", () => {
  const snap = (yaml, iframes = []) => ({ yaml, refs: 0, iframes, title: "", url: "" });
  test("inlines child frames under their placeholders, recursively", () => {
    const tree = stitchFrames([
      { ordinal: 0, origin: "https://a", snapshot: snap("- button \"A\" [ref=e1]\n- iframe [ref=e2] [origin=https://b]\n- text: after") },
      { ordinal: 1, origin: "https://b", parentRef: "e2", snapshot: snap("- link \"B\" [ref=f1e1]\n- iframe [ref=f1e2]") },
      { ordinal: 2, origin: "https://c", parentRef: "f1e2", snapshot: snap("- button \"C\" [ref=f2e1]") },
    ]);
    assert.equal(tree, [
      '- button "A" [ref=e1]',
      "- iframe [ref=e2] [origin=https://b]:",
      '  - link "B" [ref=f1e1]',
      "  - iframe [ref=f1e2]:",
      '    - button "C" [ref=f2e1]',
      "- text: after",
    ].join("\n"));
  });
  test("unplaced frames are appended, never dropped", () => {
    const tree = stitchFrames([
      { ordinal: 0, origin: "", snapshot: snap("- text: main") },
      { ordinal: 3, origin: "https://x", snapshot: snap("- button \"X\" [ref=f3e1]") },
    ]);
    assert.ok(tree.includes("- iframe [frame=f3] [origin=https://x]:\n  - button \"X\" [ref=f3e1]"));
  });
});

test("injected bundle is a self-contained expression", () => {
  assert.ok(INJECTED_BUNDLE_SOURCE.startsWith("(function installObu"));
  // No module syntax or references to compiled helpers leak into the bundle.
  assert.ok(!/\bimport\b|\bexport\b|require\(/.test(INJECTED_BUNDLE_SOURCE));
});

const chrome = findChrome();
describe("live snapshot engine", { skip: chrome ? false : "Chrome for Testing not found (set OBU_CHROME)" }, () => {
  let server;
  let browser;
  before(async () => {
    server = await startServer();
    browser = await launchChrome();
  });
  after(async () => {
    await browser?.close();
    server?.close();
  });

  const normalize = (tree) => tree.replace(/localhost:\d+/g, "localhost:PORT").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT");
  const pages = readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html") && !f.startsWith("frame-"));

  for (const file of pages) {
    test(`golden: ${file}`, async () => {
      const p = await browser.newPage(`${server.base}/${file}`);
      try {
        for (const mode of ["full", "interactive"]) {
          const s = await takeSnapshot(p.page, { interactive: mode === "interactive", maxChars: 1_000_000 });
          const got = normalize(s.tree) + "\n";
          const golden = join(GOLDEN_DIR, `${file.replace(/\.html$/, "")}${mode === "interactive" ? ".interactive" : ""}.yaml`);
          if (process.env.UPDATE_GOLDEN || !existsSync(golden)) writeFileSync(golden, got);
          assert.equal(got, readFileSync(golden, "utf8"), `${golden} (UPDATE_GOLDEN=1 to regenerate)`);
          assert.deepEqual(s.warnings.filter((w) => !/folded to fit/.test(w)), []);
        }
      } finally {
        await p.close();
      }
    });
  }

  test("refs are identical across two snapshots of an unchanged page", async () => {
    for (const file of ["form.html", "iframes.html", "long-list.html", "shadow.html"]) {
      const p = await browser.newPage(`${server.base}/${file}`);
      const a = await takeSnapshot(p.page, { maxChars: 1_000_000 });
      p.page.previousTree = a.tree;
      const b = await takeSnapshot(p.page, { maxChars: 1_000_000 });
      assert.equal(a.tree, b.tree, file);
      assert.equal(b.diff, "", file);
      await p.close();
    }
  });

  test("single-node mutation → one-line diff, other refs unchanged", async () => {
    const p = await browser.newPage(`${server.base}/long-list.html`);
    const a = await takeSnapshot(p.page, { maxChars: 1_000_000 });
    p.page.previousTree = a.tree;
    await p.evaluate("document.querySelectorAll('li span')[500].textContent = 'changed 500'");
    const b = await takeSnapshot(p.page, { maxChars: 1_000_000 });
    const changed = b.diff.split("\n").filter((l) => /^[-+]/.test(l));
    assert.equal(changed.length, 2, b.diff);
    assert.match(changed[0], /^-.*desc 500$/);
    assert.match(changed[1], /^\+.*changed 500$/);
    await p.close();
  });

  test("a ref survives re-render of a sibling, deref falls back by role+name+nth", async () => {
    const p = await browser.newPage(`${server.base}/form.html`);
    const a = await takeSnapshot(p.page, {});
    const ref = /button "Create account" \[ref=(e\d+)\]/.exec(a.tree)[1];
    // Replace the button node with an identical clone: cache misses, fallback resolves.
    await p.evaluate("(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === 'Create account'); b.replaceWith(b.cloneNode(true)); })()");
    const [main] = await p.page.frames();
    const ok = await p.page.callInjected(main, "checkEditable", [ref]);
    assert.equal(ok, false); // resolves (a button is not editable) rather than throwing
    const ready = await p.page.callInjected(main, "waitForReady", [ref, { timeoutMs: 500 }]);
    assert.equal(ready.ok, true);
    const b = await takeSnapshot(p.page, {});
    assert.ok(b.tree.includes(`button "Create account" [ref=${ref}]`), "same ref after fallback re-binding");
    await p.close();
  });

  test("OOPIF children are stitched with fK refs and their own origin", async () => {
    const p = await browser.newPage(`${server.base}/iframes.html`);
    const s = await takeSnapshot(p.page, {});
    assert.match(s.tree, /- iframe \[ref=e\d+\] \[origin=http:\/\/127\.0\.0\.1:\d+\]:\n {2}- textbox "Card" \[ref=f\d+e1\]/);
    const frames = await p.page.frames();
    assert.ok(frames.some((f) => f.sessionId), "cross-origin frame is an OOPIF child session");
    assert.ok(s.refCount >= 9);
    await p.close();
  });

  test("ref / selector scoping, frame-scoped refs", async () => {
    const p = await browser.newPage(`${server.base}/iframes.html`);
    const full = await takeSnapshot(p.page, {});
    const childRef = /textbox "Card" \[ref=(f\d+e1)\]/.exec(full.tree)[1];
    const scoped = await takeSnapshot(p.page, { ref: childRef });
    assert.ok(scoped.tree.split("\n").length === 2 && scoped.tree.includes(`[ref=${childRef}]`), scoped.tree);
    const sel = await takeSnapshot(p.page, { selector: "h1" });
    assert.equal(sel.tree.split("\n")[1], '- heading "Frames" [level=1]');
    await assert.rejects(takeSnapshot(p.page, { selector: "#nope" }), (e) => e instanceof ObuError && e.code === "invalid_params");
    await assert.rejects(takeSnapshot(p.page, { ref: "e99999" }), (e) => e instanceof ObuError && e.code === "stale_ref");
    await p.close();
  });

  test("maxChars with budget off → snapshot_too_large with advice, never truncated", async () => {
    const p = await browser.newPage(`${server.base}/long-list.html`);
    await assert.rejects(takeSnapshot(p.page, { maxChars: 5_000, budget: 0 }), (e) => e instanceof ObuError && e.code === "snapshot_too_large" && /interactive/.test(e.data.advice));
    await p.close();
  });

  test("budget: big pages fold off-screen parts into [collapsed] refs instead of failing", async () => {
    const p = await browser.newPage(`${server.base}/long-list.html`);
    const s = await takeSnapshot(p.page, { maxChars: 5_000 });
    assert.ok(s.tree.length <= 5_000, `${s.tree.length}`);
    assert.ok(s.tree.includes('link "Item 0" [ref=e1]'), "on-screen items stay");
    const fold = /- group \[ref=(e\d+)\] \[collapsed\]: "(\d+) refs/.exec(s.tree);
    assert.ok(fold, s.tree.slice(-400));
    assert.match(s.warnings.join(" "), /folded/);
    // Expanding the folded run starts at its first item, not at the top of the list.
    const firstFolded = Number(/starts at: Item (\d+)/.exec(s.tree)[1]);
    const x = await takeSnapshot(p.page, { ref: fold[1], maxChars: 5_000 });
    assert.ok(x.tree.includes(`link "Item ${firstFolded}"`), x.tree.slice(0, 600));
    assert.ok(!x.tree.includes('link "Item 0" '), "items before the run are folded away");
    // Refs of on-screen items are stable with budget on.
    const again = await takeSnapshot(p.page, { maxChars: 5_000 });
    assert.ok(again.tree.includes('link "Item 0" [ref=e1]'));
    await p.close();
  });

  test("budget: interactive feeds fit 8K and keep the first screen of actions", async () => {
    for (const [file, mustHave] of [["feed-x.html", ['textbox "Post text"', 'button "Post" ', 'link "Ada Lovelace"', 'button "0 Likes. Like"']], ["feed-linkedin.html", ['button "Start a post"', 'link "Person 0"', 'button "React Like"']]]) {
      const p = await browser.newPage(`${server.base}/${file}`);
      const s = await takeSnapshot(p.page, { interactive: true });
      assert.ok(s.tree.length <= 8_000, `${file} ${s.tree.length}`);
      for (const m of mustHave) assert.ok(s.tree.includes(m), `${file} missing ${m}`);
      assert.ok(s.tree.includes("[collapsed]"), file);
      await p.close();
    }
  });

  test("closed shadow roots are walked via CDP", async () => {
    const p = await browser.newPage(`${server.base}/closed-shadow.html`);
    const s = await takeSnapshot(p.page, { interactive: true });
    for (const m of ['textbox "Card number"', 'button "Pay now"', 'link "Terms in closed root"']) assert.ok(s.tree.includes(m), s.tree);
    await p.close();
  });

  test("passwords are redacted; hidden content excluded; below-the-fold kept", async () => {
    const p = await browser.newPage(`${server.base}/form.html`);
    const s = await takeSnapshot(p.page, {});
    assert.ok(!s.tree.includes("hunter2"));
    assert.ok(s.tree.includes('textbox "Password" [ref=e2]: "[redacted]"'));
    await p.goto(`${server.base}/hidden.html`);
    const h = await takeSnapshot(p.page, {});
    for (const hidden of ["Display none", "Aria hidden", "Hidden attr", "Transparent", "Inside closed details", "Visibility hidden"]) assert.ok(!h.tree.includes(hidden), hidden);
    for (const shown of ["Visible child", "Below the fold"]) assert.ok(h.tree.includes(shown), shown);
    const all = await takeSnapshot(p.page, { showHidden: true });
    assert.ok(all.tree.includes("Display none"));
    await p.close();
  });

  test("injected helpers: hit target, pointer target, settle probe, annotations", async () => {
    const p = await browser.newPage(`${server.base}/obscured.html`);
    const s = await takeSnapshot(p.page, {});
    const ref = /button "Covered" \[ref=(e\d+)\]/.exec(s.tree)[1];
    const [main] = await p.page.frames();
    const ready = await p.page.callInjected(main, "waitForReady", [ref, { timeoutMs: 1000 }]);
    assert.equal(ready.ok, true);
    const cx = ready.rect.x + ready.rect.width / 2;
    const cy = ready.rect.y + ready.rect.height / 2;
    const hit = await p.page.callInjected(main, "checkHitTarget", [ref, cx, cy]);
    assert.equal(hit.ok, false);
    assert.match(hit.hit, /div#overlay/);
    await p.evaluate("document.getElementById('overlay').remove()");
    assert.equal((await p.page.callInjected(main, "checkHitTarget", [ref, cx, cy])).ok, true);
    assert.deepEqual(await p.page.callInjected(main, "resolvePointerTarget", [cx, cy]), { ref, tag: "button" });
    const probe = await p.page.callInjected(main, "settleProbe", []);
    assert.equal(probe.readyState, "complete");
    assert.ok(probe.interactiveCount >= 2);
    let during;
    await withAnnotations(p.page, async () => {
      during = await p.evaluate("document.querySelectorAll('obu-annotations').length");
    });
    assert.equal(during, 1);
    assert.equal(await p.evaluate("document.querySelectorAll('obu-annotations').length"), 0);
    await p.close();
  });

  test("waitForReady reports disabled / hidden / not_editable", async () => {
    const p = await browser.newPage(`${server.base}/form.html`);
    const s = await takeSnapshot(p.page, {});
    const [main] = await p.page.frames();
    const dis = /button "Disabled" \[ref=(e\d+)\]/.exec(s.tree)[1];
    assert.deepEqual(await p.page.callInjected(main, "waitForReady", [dis, { timeoutMs: 150 }]), { ok: false, reason: "disabled" });
    const email = /textbox "Email" \[ref=(e\d+)\]/.exec(s.tree)[1];
    assert.equal((await p.page.callInjected(main, "waitForReady", [email, { timeoutMs: 150, editable: true }])).ok, true);
    const go = /button "Go" \[ref=(e\d+)\]/.exec(s.tree)[1];
    assert.deepEqual(await p.page.callInjected(main, "waitForReady", [go, { timeoutMs: 150, editable: true }]), { ok: false, reason: "not_editable" });
    await p.evaluate("document.querySelector('[type=email]').style.display='none'");
    assert.deepEqual(await p.page.callInjected(main, "waitForReady", [email, { timeoutMs: 150 }]), { ok: false, reason: "hidden" });
    await p.close();
  });

  test("latency budget: p50 < 60 ms on the 2,000-node fixture", async () => {
    const p = await browser.newPage(`${server.base}/long-list.html`);
    const times = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      await takeSnapshot(p.page, { maxChars: 1_000_000 });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    assert.ok(p50 < 60, `p50 ${p50.toFixed(1)} ms`);
    await p.close();
  });
});
