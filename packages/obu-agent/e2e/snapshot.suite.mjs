// Snapshot engine (WS-D, contract.md §Snapshot): refs, stability, diff, frames, shadow DOM,
// visibility, compaction, size errors and speed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectCode, pct, pendingAware, refOf, Pending } from "./lib/harness.mjs";
import { attachPage } from "./lib/cdp.mjs";

const e2e = pendingAware(test);
const refRe = /\[ref=(\w+)\]/g;
const refsIn = (tree) => [...tree.matchAll(refRe)].map((m) => m[1]);

e2e("snapshot: form page has header, role/name lines and refs on interactive nodes only", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-form");
  const tab = await ctx.open(s, "form.html");
  const snap = await ctx.snap(tab);
  assert.match(snap.tree.split("\n")[0], /^- title: "Form fixture" \[url=.*form\.html\]/);
  assert.equal(snap.title, "Form fixture");
  for (const re of [/textbox "Full name".*\[ref=e\d+\]/, /textbox "Email".*\[ref=/, /checkbox "I accept the terms".*\[ref=/, /button "Create account".*\[ref=/, /combobox "Country".*\[ref=/, /radio "Pro".*\[ref=/, /heading "Sign-up form"/])
    assert.match(snap.tree, re);
  assert.doesNotMatch(snap.tree, /heading "Sign-up form".*\[ref=/, "headings are not interactive");
  const refs = refsIn(snap.tree);
  assert.equal(new Set(refs).size, refs.length, "refs unique");
  assert.equal(snap.refCount, refs.length);
  assert.match(snap.tree, /radio "Free".*\[checked\]/);
});

e2e("snapshot: password values are redacted", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-pw");
  const tab = await ctx.open(s, "form.html");
  await ctx.fx(tab, "document.getElementById('password').value = 'hunter2-SECRET', true");
  const snap = await ctx.snap(tab);
  assert.doesNotMatch(snap.tree, /hunter2-SECRET/);
});

e2e("snapshot: refs are stable across snapshots and diff is empty for an unchanged page", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-stable");
  const tab = await ctx.open(s, "form.html");
  const a = await ctx.snap(tab);
  const b = await ctx.snap(tab);
  assert.equal(b.tree, a.tree);
  assert.equal(b.diff.trim(), "");
});

e2e("snapshot: a single-node mutation yields a small unified diff", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-diff");
  const tab = await ctx.open(s, "form.html");
  await ctx.snap(tab);
  await ctx.fx(tab, "document.getElementById('result').textContent = 'Changed status line', true");
  const b = await ctx.snap(tab);
  // Changed lines start with +/-; snapshot lines themselves start with "- ", so "+- text" is a change.
  // Only unified-diff file headers ("+++ ", "--- ") are excluded.
  const changed = b.diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  assert.ok(changed.some((l) => l.includes("Changed status line")), b.diff);
  assert.ok(changed.length <= 4, `diff too large (${changed.length}):\n${b.diff}`);
});

e2e("snapshot: iframes are stitched with origin and fKeN refs (same-origin + OOPIF + nested)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-frames");
  const tab = await ctx.open(s, "iframes.html");
  const snap = await ctx.snap(tab);
  assert.match(snap.tree, /- iframe .*\[ref=\w+\].*\[origin=/);
  assert.ok(snap.tree.includes(`[origin=${ctx.env.fixtures.crossOrigin}]`), "cross-origin frame origin shown");
  const holders = [...snap.tree.matchAll(/textbox "Card holder".*\[ref=(f\d+e\d+)\]/g)].map((m) => m[1]);
  assert.equal(holders.length, 2, `two framed forms with fKeN refs:\n${snap.tree}`);
  assert.notEqual(holders[0].split("e")[0], holders[1].split("e")[0], "distinct frame ordinals");
  assert.match(snap.tree, /button "Leaf button".*\[ref=f\d+e\d+\]/, "nested frame inside OOPIF");
});

e2e("snapshot: open shadow DOM (incl. nested + slotted) is walked", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-shadow");
  const tab = await ctx.open(s, "shadow.html");
  const snap = await ctx.snap(tab);
  assert.match(snap.tree, /textbox "Search".*\[ref=/);
  assert.match(snap.tree, /button "Open shadow button".*\[ref=/);
  assert.match(snap.tree, /button "Deep button".*\[ref=/);
  assert.match(snap.tree, /Slotted label text/);
  if (!/button "Closed shadow button"/.test(snap.tree)) ctx.t.diagnostic("closed shadow root not reachable (WS-D stretch: DOM.getDocument pierce)");
});

e2e("snapshot: hidden subtrees dropped, below-the-fold kept, showHidden reveals", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-hidden");
  const tab = await ctx.open(s, "hidden.html");
  const snap = await ctx.snap(tab);
  assert.match(snap.tree, /button "Visible button"/);
  assert.match(snap.tree, /button "Below the fold button".*\[ref=/, "agents never need to scroll to see content");
  for (const hidden of ["display none button", "visibility hidden button", "aria-hidden button", "hidden attribute text"]) assert.ok(!snap.tree.includes(hidden), `${hidden} should be hidden`);
  const all = await ctx.snap(tab, { showHidden: true });
  assert.ok(all.tree.includes("display none button"));
});

e2e("snapshot: aria-owns reparents the listbox/tree item", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-owns");
  const tab = await ctx.open(s, "aria-owns.html");
  await ctx.fx(tab, "document.getElementById('cb').dispatchEvent(new FocusEvent('focus')), true");
  const snap = await ctx.snap(tab);
  const lines = snap.tree.split("\n");
  const indent = (re) => { const l = lines.find((x) => re.test(x)); assert.ok(l, `${re} missing:\n${snap.tree}`); return l.search(/\S/); };
  assert.ok(indent(/treeitem "Reparented tree item"/) > indent(/- tree\b/), "owned tree item nested under tree");
  assert.match(snap.tree, /option "Banana"/);
});

e2e("snapshot: cursor:pointer / onclick / tabindex / role=button divs get refs", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-ptr");
  const tab = await ctx.open(s, "pointer-divs.html");
  const snap = await ctx.snap(tab, { interactive: true });
  for (const name of ["Div with onclick", "Div with tabindex", "Role button div"]) refOf(snap.tree, new RegExp(name));
  const spanLines = snap.tree.split("\n").filter((l) => l.includes("Inherited pointer span") && /\[ref=/.test(l));
  assert.ok(spanLines.length <= 1, "inherited cursor:pointer does not create extra refs");
});

e2e("snapshot: selector and ref scoping", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-scope");
  const tab = await ctx.open(s, "dialogs.html");
  const scoped = await ctx.snap(tab, { selector: "#modal" });
  assert.ok(!scoped.tree.includes("Show alert"), "selector scope excludes outside nodes");
  const full = await ctx.snap(tab);
  const ref = refOf(full.tree, /button "Show alert"/);
  const one = await ctx.snap(tab, { ref });
  assert.match(one.tree, /Show alert/);
  assert.ok(!one.tree.includes("Show confirm"));
});

e2e("snapshot: over maxChars is a typed error with advice, never a truncated tree", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-big");
  const tab = await ctx.open(s, "long-list.html");
  const err = await expectCode(ctx.snap(tab, { maxChars: 500 }), "snapshot_too_large");
  assert.ok(err.data?.advice || /interactive|ref|selector/i.test(err.message), "advice provided");
});

e2e("snapshot: 2,000-node page interactive p50 < 60 ms; compact vs innerText + AX dump", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("snap-perf");
  const tab = await ctx.open(s, "long-list.html");
  await ctx.snap(tab, { interactive: true });
  const ms = [];
  for (let i = 0; i < 12; i++) { const t0 = performance.now(); await ctx.snap(tab, { interactive: true }); ms.push(performance.now() - t0); }
  ctx.t.diagnostic(`interactive snapshot p50=${pct(ms, 50).toFixed(1)} p95=${pct(ms, 95).toFixed(1)} ms`);
  assert.ok(pct(ms, 50) < 60, `p50 ${pct(ms, 50).toFixed(1)} ms`);
  if (ctx.env.cdp) {
    const full = await ctx.snap(tab, { maxChars: 400_000 });
    const page = await attachPage(ctx.env.cdp, tab.targetId);
    try {
      const inner = (await page.evaluate("document.body.innerText")).length;
      const ax = JSON.stringify(await page.send("Accessibility.getFullAXTree", {})).length;
      ctx.t.diagnostic(`full tree ${full.tree.length} chars vs innerText ${inner} + AX ${ax}`);
      assert.ok(full.tree.length < 0.5 * (inner + ax));
    } finally { await page.detach(); }
  }
});
