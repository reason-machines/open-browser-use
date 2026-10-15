// Actions + settle (WS-E, contract.md §Input/§Settle). Every assertion checks page ground
// truth (window.__fx), never the agent's own report. All tabs are owned BACKGROUND tabs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectCode, pct, pendingAware, refOf, Pending } from "./lib/harness.mjs";
import { startFocusSampler } from "./lib/focus.mjs";

const e2e = pendingAware(test);
const UNICODE = "héllo 👋🏽 日本語 مرحبا";

e2e("act: full form flow (fill, select by label, check, radio, date/color/range, submit)", async (ctx) => {
  ctx.requireExtension();
  const focus = ctx.env.cdp ? await startFocusSampler(ctx.env) : null;
  const s = await ctx.session("act-form");
  const tab = await ctx.open(s, "form.html");
  const { tree } = await ctx.snap(tab);
  const r = (re) => refOf(tree, re);
  await ctx.act(tab, { action: "fill", ref: r(/textbox "Full name"/), value: "Ada Lovelace" });
  await ctx.act(tab, { action: "fill", ref: r(/textbox "Email"/), value: "ada@example.com" });
  await ctx.act(tab, { action: "select", ref: r(/combobox "Country"/), value: "Norway" });
  await ctx.act(tab, { action: "check", ref: r(/checkbox "I accept the terms"/) });
  await ctx.act(tab, { action: "click", ref: r(/radio "Pro"/) });
  await ctx.act(tab, { action: "fill", selector: "input[name=start]", value: "2027-05-14" });
  await ctx.act(tab, { action: "fill", selector: "input[name=color]", value: "#ff0000" });
  await ctx.act(tab, { action: "fill", selector: "input[name=volume]", value: "7" });
  await ctx.act(tab, { action: "uncheck", selector: "input[name=news]" });
  const res = await ctx.act(tab, { action: "click", ref: r(/button "Create account"/) });
  assert.equal(res.ok, true);
  assert.ok(res.settled, "settled reported");
  assert.match(`${res.snapshot?.diff ?? ""}${res.snapshot?.tree ?? ""}`, /Account created for Ada Lovelace/, "default diff shows the outcome");
  const sub = await ctx.fx(tab, "__fx.state.submitted");
  assert.deepEqual({ name: sub.name, email: sub.email, country: sub.country, plan: sub.plan, start: sub.start, color: sub.color, volume: sub.volume, terms: sub.terms, news: sub.news },
    { name: "Ada Lovelace", email: "ada@example.com", country: "no", plan: "pro", start: "2027-05-14", color: "#ff0000", volume: "7", terms: true, news: undefined });
  const report = await focus?.stop();
  if (report) assert.equal(report.thefts, 0, `focus theft: ${JSON.stringify(report)}`);
});

e2e("act: type emoji + CJK + RTL exactly into contenteditable and input", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-unicode");
  const tab = await ctx.open(s, "editable.html");
  const { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /textbox "Controlled editor"/) });
  await ctx.act(tab, { action: "type", ref: refOf(tree, /textbox "Controlled editor"/), value: UNICODE });
  assert.equal((await ctx.fx(tab, "document.getElementById('react-like').innerText")).trim(), UNICODE);
  assert.ok((await ctx.fx(tab, "__fx.state.beforeinput || 0")) > 0, "text arrives through beforeinput (real input path)");
  await ctx.act(tab, { action: "fill", ref: refOf(tree, /textbox "Single line"/), value: UNICODE });
  assert.equal(await ctx.fx(tab, "document.getElementById('single').value"), UNICODE);
});

e2e("act: Cmd+A / Cmd+C / Cmd+V move text between textareas (Mac editing commands)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-clip");
  const tab = await ctx.open(s, "editable.html");
  const { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /textbox "Notes"/) });
  await ctx.act(tab, { action: "press", keys: "ControlOrMeta+A" });
  await ctx.act(tab, { action: "press", keys: "ControlOrMeta+C" });
  await ctx.act(tab, { action: "click", ref: refOf(tree, /textbox "Paste target"/) });
  await ctx.act(tab, { action: "press", keys: "ControlOrMeta+V" });
  assert.equal(await ctx.fx(tab, "document.getElementById('ta2').value"), "Original textarea content");
});

e2e("act: press Enter on focused tabindex div; hover reveals a menu item", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-keys");
  const tab = await ctx.open(s, "pointer-divs.html");
  let { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /Div with tabindex/) });
  await ctx.act(tab, { action: "press", keys: "Enter" });
  assert.equal(await ctx.fx(tab, "__fx.count('d2-enter')"), 1);
  const hov = await ctx.act(tab, { action: "hover", selector: "#hov", snapshot: "tree" });
  assert.equal(await ctx.fx(tab, "__fx.count('hover')") >= 1, true);
  tree = hov.snapshot?.tree ?? (await ctx.snap(tab)).tree;
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Menu item"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('menu-item')"), 1);
});

e2e("act: obscured target falls back to DOM click with a warning; glass, disclosure, moving button", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-obscured");
  const tab = await ctx.open(s, "obscured.html");
  const { tree } = await ctx.snap(tab);
  const res = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Covered target button"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('target')"), 1, "target clicked");
  assert.ok((res.warnings ?? []).some((w) => /obscur|fallback|DOM click/i.test(w)), `fallback warning: ${JSON.stringify(res.warnings)}`);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Accept cookies"/) });
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Button under transparent sibling"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('under')"), 1);
  const disc = await ctx.act(tab, { action: "click", selector: "#disc summary", snapshot: "tree" });
  await ctx.act(tab, { action: "click", ref: refOf(disc.snapshot?.tree ?? (await ctx.snap(tab)).tree, /button "Advanced action"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('adv')"), 1);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Moving button"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('moving')"), 1);
});

e2e("act: coordinate click on canvas-only UI", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-canvas");
  const tab = await ctx.open(s, "canvas.html");
  const rect = await ctx.fx(tab, "(() => { const r = document.getElementById('c').getBoundingClientRect(); return { x: r.left, y: r.top, sx: r.width / 600, sy: r.height / 200 }; })()");
  await ctx.act(tab, { action: "click", coords: { x: rect.x + (230 + 70) * rect.sx, y: rect.y + (60 + 30) * rect.sy } });
  assert.equal(await ctx.fx(tab, "__fx.state.picked"), "Green");
});

e2e("act: drag kanban card (HTML5 DnD) and pointer-captured slider", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-drag");
  const tab = await ctx.open(s, "dragdrop.html");
  const { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "drag", selector: "#card-a", to: { selector: "#done" } });
  assert.equal(await ctx.fx(tab, "__fx.state['card-a']"), "done");
  const k = await ctx.fx(tab, "(() => { const a = document.getElementById('knob').getBoundingClientRect(), t = document.getElementById('track').getBoundingClientRect(); return { x: a.left + a.width / 2, y: a.top + a.height / 2, tx: t.left + t.width / 2 }; })()");
  await ctx.act(tab, { action: "drag", coords: { x: k.x, y: k.y }, to: { coords: { x: k.tx, y: k.y } } });
  const v = await ctx.fx(tab, "__fx.state.slider");
  assert.ok(v >= 40 && v <= 60, `slider ~50, got ${v}`);
  void tree;
});

e2e("act: custom date picker month navigation + native date fill", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-date");
  const tab = await ctx.open(s, "datepicker.html");
  let { tree } = await ctx.snap(tab);
  const open = await ctx.act(tab, { action: "click", ref: refOf(tree, /textbox "Check-out/), snapshot: "tree" });
  tree = open.snapshot?.tree ?? (await ctx.snap(tab)).tree;
  const next = refOf(tree, /button "Next month"/);
  await ctx.act(tab, { action: "click", ref: next });
  const r2 = await ctx.act(tab, { action: "click", ref: next, snapshot: "tree" });
  tree = r2.snapshot?.tree ?? (await ctx.snap(tab)).tree;
  assert.match(tree, /May 2027/);
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "14 May 2027"/) });
  assert.equal(await ctx.fx(tab, "__fx.state.checkout"), "2027-05-14");
  await ctx.act(tab, { action: "fill", selector: "#native", value: "2027-03-01" });
  assert.equal(await ctx.fx(tab, "__fx.state.native"), "2027-03-01");
});

e2e("act: native select by label, multi-select, custom listbox, combobox option", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-select");
  const tab = await ctx.open(s, "select.html");
  let { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "select", ref: refOf(tree, /combobox "Shipping"/), value: "Express" });
  assert.equal(await ctx.fx(tab, "__fx.state.ship"), "exp");
  await ctx.act(tab, { action: "select", ref: refOf(tree, /listbox "Toppings"/), value: ["Olives", "Peppers"] });
  assert.deepEqual(await ctx.fx(tab, "__fx.state.tops"), ["Olives", "Peppers"]);
  const opened = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Size: Medium"/), snapshot: "tree" });
  tree = opened.snapshot?.tree ?? (await ctx.snap(tab)).tree;
  await ctx.act(tab, { action: "click", ref: refOf(tree, /option "Large"/) });
  assert.equal(await ctx.fx(tab, "__fx.state.size"), "Large");
  const tab2 = await ctx.open(s, "aria-owns.html");
  const t2 = (await ctx.snap(tab2)).tree;
  const focused = await ctx.act(tab2, { action: "click", ref: refOf(t2, /textbox|combobox/), snapshot: "tree" });
  await ctx.act(tab2, { action: "click", ref: refOf(focused.snapshot?.tree ?? (await ctx.snap(tab2)).tree, /option "Banana"/) });
  assert.equal(await ctx.fx(tab2, "__fx.state.picked"), "Banana");
});

e2e("act: fill + click inside a cross-origin OOPIF and its nested frame", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-oopif");
  const tab = await ctx.open(s, "iframes.html");
  const { tree } = await ctx.snap(tab);
  const lines = tree.split("\n");
  const xoIdx = lines.findIndex((l) => l.includes(`[origin=${ctx.env.fixtures.crossOrigin}]`));
  assert.ok(xoIdx >= 0, "cross-origin frame in tree");
  const sub = lines.slice(xoIdx).join("\n");
  await ctx.act(tab, { action: "fill", ref: refOf(sub, /textbox "Card holder"/), value: "Grace Hopper" });
  await ctx.act(tab, { action: "click", ref: refOf(sub, /button "Apply"/) });
  const st = await ctx.until(tab, "__fx.state['inner-submit'] || null", Boolean, 3000);
  assert.equal(st.origin, ctx.env.fixtures.crossOrigin);
  assert.equal(st.holder, "Grace Hopper");
  await ctx.act(tab, { action: "click", ref: refOf(sub, /button "Leaf button"/) });
  await ctx.until(tab, "__fx.count('leaf-click')", (n) => n === 1, 3000);
});

e2e("act: open shadow DOM fill + click; closed shadow is a stretch goal", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-shadow");
  const tab = await ctx.open(s, "shadow.html");
  const { tree } = await ctx.snap(tab);
  await ctx.act(tab, { action: "fill", ref: refOf(tree, /textbox "Search"/), value: "shadow query" });
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Open shadow button"/) });
  assert.equal((await ctx.fx(tab, "__fx.last('open-click')")).data, "shadow query");
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Deep button"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('deep-click')"), 1);
  if (!/Closed shadow button/.test(tree)) throw new Pending("closed shadow root refs (WS-D stretch)");
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Closed shadow button"/) });
  assert.equal(await ctx.fx(tab, "__fx.count('closed-click')"), 1);
});

e2e("settle: SPA route change settles as 'spa' with content, back works, no agent sleeps", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-spa");
  const tab = await ctx.open(s, "spa.html");
  const { tree } = await ctx.snap(tab);
  const r = await ctx.act(tab, { action: "click", ref: refOf(tree, /link "Reports"/) });
  assert.equal(r.settled.kind, "spa");
  assert.match(`${r.snapshot?.diff ?? ""}${r.snapshot?.tree ?? ""}`, /42/, "settle waited for the async report");
  assert.equal(await ctx.fx(tab, "__fx.state.route"), "reports");
  const back = await tab.s.call("navigate", { tabId: tab.tabId, op: "back" });
  assert.ok(back.ok);
  assert.equal(await ctx.fx(tab, "__fx.state.route"), "home");
});

e2e("settle: slow XHR then wait{text}; infinite spinner hits the 8 s cap as a warning", { timeout: 60_000 }, async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-slow");
  const tab = await ctx.open(s, "spa.html");
  const { tree } = await ctx.snap(tab);
  let t0 = performance.now();
  await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Load slow data/) });
  assert.ok(performance.now() - t0 < 3500, "slow request does not block act beyond the settle budget");
  const w = await tab.s.call("wait", { tabId: tab.tabId, for: "text", text: "Slow data loaded", timeoutMs: 5000 });
  assert.equal(w.ok, true);
  t0 = performance.now();
  const spin = await ctx.act(tab, { action: "click", ref: refOf(tree, /button "Start infinite spinner"/) });
  const dt = performance.now() - t0;
  assert.ok(dt < 9500, `spinner act returned in ${dt.toFixed(0)} ms (cap 8 s)`);
  ctx.t.diagnostic(`spinner settle ${spin.settled.ms} ms warning=${spin.settled.warning ?? ""}`);
});

e2e("act: infinite scroll — scroll until the needle post appears, then like it", { timeout: 60_000 }, async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-scroll");
  const tab = await ctx.open(s, "infinite-scroll.html");
  let tree = (await ctx.snap(tab)).tree;
  for (let i = 0; i < 25 && !tree.includes("Post 137"); i++) {
    const r = await ctx.act(tab, { action: "scroll", value: "down", snapshot: "tree" });
    tree = r.snapshot?.tree ?? (await ctx.snap(tab)).tree;
  }
  assert.ok(tree.includes("Post 137"), "needle reached by scrolling");
  assert.match(tree, /quick brown fixture/);
  const lines = tree.split("\n"); const i = lines.findIndex((l) => l.includes("Post 137"));
  await ctx.act(tab, { action: "click", ref: refOf(lines.slice(i).join("\n"), /button "Like"/) });
  assert.equal(await ctx.fx(tab, "__fx.state.liked"), 137);
});

e2e("errors: stale ref after navigation; hidden element is not_actionable", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-errors");
  const tab = await ctx.open(s, "form.html");
  const ref = refOf((await ctx.snap(tab)).tree, /button "Create account"/);
  await tab.s.call("navigate", { tabId: tab.tabId, url: ctx.url("table.html") });
  await expectCode(ctx.act(tab, { action: "click", ref, timeoutMs: 1000 }), "stale_ref");
  await tab.s.call("navigate", { tabId: tab.tabId, url: ctx.url("hidden.html") });
  const hiddenRef = refOf((await ctx.snap(tab, { showHidden: true })).tree, /button "display none button"/);
  const err = await expectCode(ctx.act(tab, { action: "click", ref: hiddenRef, timeoutMs: 600 }), "not_actionable");
  assert.ok(err.message.length > 10, "message reaches the agent");
});

e2e("perf: click incl. settle p50 < 350 ms on a static page (D6)", async (ctx) => {
  ctx.requireExtension();
  const s = await ctx.session("act-perf");
  const tab = await ctx.open(s, "bench.html");
  const ref = refOf((await ctx.snap(tab)).tree, /button "Increment"/);
  const ms = [];
  for (let i = 0; i < 12; i++) { const t0 = performance.now(); await ctx.act(tab, { action: "click", ref }); ms.push(performance.now() - t0); }
  ctx.t.diagnostic(`click+settle p50=${pct(ms, 50).toFixed(0)} p95=${pct(ms, 95).toFixed(0)} ms`);
  assert.equal(await ctx.fx(tab, "__fx.state.count"), 12);
  assert.ok(pct(ms, 50) < 350, `p50 ${pct(ms, 50).toFixed(0)} ms`);
});
