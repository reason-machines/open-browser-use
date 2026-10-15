// WS-E live e2e: actions, settle, screenshots, uploads, downloads on OWNED
// BACKGROUND tabs in Chrome for Testing while another ("user") tab is focused.
// Skips when Chrome for Testing is not installed. OBU_E2E_HEADFUL=1 runs headful
// (launched with `open -g`, never brought to the front).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, navigate } from "../dist/actions/index.js";
import { screenshot } from "../dist/screenshot/index.js";
import { waitFor } from "../dist/wait/index.js";
import { findChrome, launchChrome, percentile, startPages } from "./actions-harness.mjs";

const skip = !findChrome() || process.env.OBU_E2E === "0" ? "Chrome for Testing not found (set OBU_CFT)" : false;

const BASE_CSS = "<style>body{font:14px sans-serif;margin:20px} .pad{height:1400px}</style>";
const page = (title, body) => `<!doctype html><html><head><title>${title}</title>${BASE_CSS}</head><body>${body}</body></html>`;

const ROUTES = {
  "/click": page("click", `
    <button data-ref="e1" onclick="window.n=(window.n||0)+1;document.getElementById('out').textContent='clicked '+window.n">Count</button>
    <span id="out"></span>
    <div class="pad"></div>
    <button data-ref="e2" onclick="document.getElementById('far').textContent='far clicked'">Far below</button><span id="far"></span>
    <button data-ref="e3" ondblclick="document.getElementById('dbl').textContent='double'">Dbl</button><span id="dbl"></span>
    <div data-ref="e4" onmouseover="document.getElementById('hov').textContent='hovered'" style="width:100px;height:30px;background:#ccc">hover me</div><span id="hov"></span>`),
  "/obscured": page("obscured", `
    <button data-ref="e1" onclick="document.getElementById('o').textContent='under clicked'">Under</button><span id="o"></span>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.2);z-index:10" id="overlay"></div>
    <button data-ref="e2" aria-expanded="false" style="position:relative;z-index:20" onmousedown="event.preventDefault()" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded')==='true'?'false':'true')">Menu</button>`),
  "/form": page("form", `
    <input data-ref="e1" id="name" value="old">
    <input data-ref="e2" id="date" type="date">
    <input data-ref="e3" id="color" type="color">
    <label><input data-ref="e4" id="agree" type="checkbox" style="display:none"> I agree</label>
    <input data-ref="e5" id="cb" type="checkbox">
    <select data-ref="e6" id="sel"><option value="a">Apple</option><option value="b">Banana</option><option value="c">Cherry</option></select>
    <select data-ref="e7" id="multi" multiple><option value="1">One</option><option value="2">Two</option><option value="3">Three</option></select>
    <input data-ref="e8" id="disabled" disabled>
    <input data-ref="e9" id="range" type="range" min="0" max="10">
    <input data-ref="e10" id="keys" onkeydown="(window.kk=window.kk||[]).push(event.key)">`),
  "/editable": page("editable", `
    <textarea data-ref="e1" id="t1"></textarea>
    <textarea data-ref="e2" id="t2"></textarea>
    <div data-ref="e3" id="ce" contenteditable="true" style="min-height:40px;border:1px solid #999"></div>
    <input data-ref="e4" id="i1">`),
  "/spa": page("spa", `
    <a data-ref="e1" href="/spa/next" onclick="event.preventDefault();history.pushState({},'','/spa/next');setTimeout(()=>{document.getElementById('view').innerHTML='<h2 id=routed>Next route</h2>'},120)">Go next</a>
    <div id="view"><h2>Home route</h2></div>
    <button data-ref="e2" onclick="fetch('/slow?ms=700').then(r=>r.json()).then(()=>{document.getElementById('xhr').textContent='xhr done'})">Load</button><span id="xhr"></span>
    <a data-ref="e3" href="/nav-target">Real nav</a>`),
  "/nav-target": page("nav target", `<main><h1 id="landed">Landed</h1><button>ok</button></main>`),
  "/slow": async (url) => {
    await new Promise((r) => setTimeout(r, Number(url.searchParams.get("ms") ?? 1000)));
    return { headers: { "content-type": "application/json" }, body: '{"ok":true}' };
  },
  "/upload": page("upload", `
    <input data-ref="e1" id="f" type="file" multiple onchange="window.readAll(this.files)">
    <button data-ref="e2" onclick="document.getElementById('hiddenfile').click()">Choose file…</button>
    <input id="hiddenfile" type="file" style="display:none" onchange="window.readAll(this.files)">
    <div data-ref="e3" id="drop" style="width:200px;height:80px;border:2px dashed #999"
      ondragover="event.preventDefault()" ondrop="event.preventDefault();window.readAll(event.dataTransfer.files)">Drop here</div>
    <script>
      window.readAll = async (files) => {
        window.uploaded = await Promise.all(Array.from(files).map(async f => ({ name: f.name, type: f.type, size: f.size, text: await f.text() })));
      };
    </script>`),
  "/download": (url) => page("download", `<a data-ref="e1" href="/file?name=${url.searchParams.get("name")}&delay=${url.searchParams.get("delay") ?? 0}">Download ${url.searchParams.get("name")}</a>`),
  "/file": async (url) => {
    await new Promise((r) => setTimeout(r, Number(url.searchParams.get("delay") ?? 0)));
    const name = url.searchParams.get("name");
    return { headers: { "content-type": "text/plain", "content-disposition": `attachment; filename="${name}.txt"` }, body: `contents of ${name}\n`.repeat(2000) };
  },
  "/drag": page("drag", `
    <div data-ref="e1" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','card-1')" style="width:80px;height:40px;background:#9cf">Card</div>
    <div data-ref="e2" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.getElementById('dz').textContent='dropped '+event.dataTransfer.getData('text/plain')" style="width:200px;height:80px;background:#eee">Zone</div><span id="dz"></span>
    <div id="slider" data-ref="e3" style="width:30px;height:30px;background:#f96;position:absolute;left:300px;top:200px"
      onpointerdown="this.dragging=true;this.setPointerCapture(event.pointerId)" onpointermove="if(this.dragging){this.style.left=(event.clientX-15)+'px'}" onpointerup="this.dragging=false;document.getElementById('sl').textContent='moved to '+parseInt(this.style.left)"></div><span id="sl"></span>`),
  "/scroll": page("scroll", `<div data-ref="e1" id="box" style="height:100px;overflow:auto;border:1px solid"><div style="height:1000px">tall</div></div><div class="pad"></div>`),
  "/frames": (url) => page("frames", `
    <iframe id="same" src="/inner?label=same" style="width:300px;height:120px;margin-top:40px"></iframe>
    <iframe id="cross" src="${url.searchParams.get("cross")}/inner?label=cross" style="width:300px;height:120px;margin-left:30px"></iframe>`),
  "/inner": (url) => page("inner", `<button data-ref="e1" onclick="document.getElementById('r').textContent='${url.searchParams.get("label")} clicked'">${url.searchParams.get("label")} button</button><span id="r"></span>`),
  "/dialog": page("dialog", `<button data-ref="e1" onclick="alert('hello');document.getElementById('d').textContent='after alert'">Alert</button><span id="d"></span>
    <button data-ref="e2" onclick="document.getElementById('c').textContent=String(confirm('sure?'))">Confirm</button><span id="c"></span>`),
  "/shadow": page("shadow", `<div id="host"></div><script>
    const r = document.getElementById('host').attachShadow({mode:'open'});
    r.innerHTML = '<button data-ref="e1">Shadow btn</button><span id=s></span>';
    r.querySelector('button').onclick = () => { r.getElementById('s').textContent = 'shadow clicked'; };
  </script>`),
};

let browser, server, userTab;

before(async () => {
  if (skip) return;
  server = await startPages(ROUTES);
  browser = await launchChrome();
  // The "user's" tab: foreground, never touched by the agent.
  userTab = await browser.openTab(`${server.origin}/nav-target`, { foreground: true, owned: false });
  await browser.activate(userTab);
});

after(async () => {
  if (skip) return;
  await browser?.close();
  await server?.close();
});

async function agentTab(path) {
  const tab = await browser.openTab(`${server.origin}${path}`);
  return { tab, page: tab.page() };
}

async function userForegroundUnchanged() {
  const s = await userTab.eval("({v: document.visibilityState, url: location.pathname})");
  assert.equal(s.url, "/nav-target");
  if (browser.info.headful) assert.equal(s.v, "visible", "user tab must stay in front");
}

test("click on a background owned tab: p50 < 300 ms incl. settle; user tab untouched", { skip }, async () => {
  const { tab, page } = await agentTab("/click");
  assert.equal(await tab.eval("document.visibilityState"), browser.info.headful ? "hidden" : await tab.eval("document.visibilityState"));
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    const r = await act(page, { action: "click", ref: "e1" });
    times.push(performance.now() - t0);
    assert.equal(r.ok, true);
    assert.equal(r.settled.kind, "dom");
  }
  assert.equal(await tab.eval("window.n"), 30);
  const p50 = percentile(times, 50), p95 = percentile(times, 95);
  console.log(`# click incl. settle: p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms`);
  assert.ok(p50 < 300, `click p50 ${p50}`);
  await userForegroundUnchanged();
});

test("auto-scroll to off-screen element, dblclick, hover", { skip }, async () => {
  const { tab, page } = await agentTab("/click");
  await act(page, { action: "click", ref: "e2" });
  assert.equal(await tab.eval("document.getElementById('far').textContent"), "far clicked");
  await act(page, { action: "dblclick", ref: "e3" });
  assert.equal(await tab.eval("document.getElementById('dbl').textContent"), "double");
  await act(page, { action: "hover", ref: "e4" });
  assert.equal(await tab.eval("document.getElementById('hov').textContent"), "hovered");
});

test("obscured element falls back to DOM click; disclosure verify", { skip }, async () => {
  const { tab, page } = await agentTab("/obscured");
  const r = await act(page, { action: "click", ref: "e1" });
  assert.match(r.warnings.join(" "), /obscured/);
  assert.equal(await tab.eval("document.getElementById('o').textContent"), "under clicked");
  await act(page, { action: "click", ref: "e2" });
  assert.equal(await tab.eval("document.querySelector('[data-ref=e2]').getAttribute('aria-expanded')"), "true");
  await assert.rejects(act(page, { action: "hover", ref: "e1" }), (e) => e.code === "obscured" && /covered/.test(e.message));
});

test("fill / date / color / range / select / check (hidden checkbox via label) / disabled error", { skip }, async () => {
  const { tab, page } = await agentTab("/form");
  await act(page, { action: "fill", ref: "e1", value: "Ada Lovelace" });
  assert.equal(await tab.eval("document.getElementById('name').value"), "Ada Lovelace");
  await act(page, { action: "fill", ref: "e2", value: "2026-10-15" });
  assert.equal(await tab.eval("document.getElementById('date').value"), "2026-10-15");
  await act(page, { action: "fill", ref: "e3", value: "#ff0000" });
  assert.equal(await tab.eval("document.getElementById('color').value"), "#ff0000");
  await act(page, { action: "fill", ref: "e9", value: "7" });
  assert.equal(await tab.eval("document.getElementById('range').value"), "7");
  await act(page, { action: "check", ref: "e4" });
  assert.equal(await tab.eval("document.getElementById('agree').checked"), true);
  await act(page, { action: "check", ref: "e5" });
  assert.equal(await tab.eval("document.getElementById('cb').checked"), true);
  const again = await act(page, { action: "check", ref: "e5" });
  assert.match(again.warnings.join(" "), /already checked/);
  await act(page, { action: "uncheck", ref: "e5" });
  assert.equal(await tab.eval("document.getElementById('cb').checked"), false);
  const sel = await act(page, { action: "select", ref: "e6", value: "Banana" });
  assert.deepEqual(sel.details.selected, ["b"]);
  assert.equal(await tab.eval("document.getElementById('sel').value"), "b");
  await act(page, { action: "select", ref: "e7", value: ["One", "3"] });
  assert.deepEqual(await tab.eval("Array.from(document.getElementById('multi').selectedOptions).map(o=>o.value)"), ["1", "3"]);
  await assert.rejects(act(page, { action: "fill", ref: "e8", value: "x", timeoutMs: 300 }), (e) => e.code === "not_actionable" && e.data.reason === "disabled");
  await assert.rejects(act(page, { action: "click", ref: "e99" }), (e) => e.code === "stale_ref");
  await act(page, { action: "press", ref: "e10", keys: "Shift+Tab" });
  await act(page, { action: "press", ref: "e10", keys: "a Enter" });
  assert.deepEqual((await tab.eval("window.kk")).filter((k) => k !== "Shift"), ["Tab", "a", "Enter"]);
});

test("textarea Cmd/Ctrl+A/C/V and exact emoji + CJK in contenteditable", { skip }, async () => {
  const { tab, page } = await agentTab("/editable");
  await act(page, { action: "fill", ref: "e1", value: "copy me 🙂" });
  await act(page, { action: "press", ref: "e1", keys: "ControlOrMeta+A" });
  assert.equal(await tab.eval("t1.selectionStart === 0 && t1.selectionEnd === t1.value.length"), true);
  await act(page, { action: "press", ref: "e1", keys: "ControlOrMeta+C" });
  await act(page, { action: "click", ref: "e2" });
  await act(page, { action: "press", ref: "e2", keys: "ControlOrMeta+V" });
  const pasted = await tab.eval("t2.value");
  // Clipboard can be unavailable to headless CfT; headful must paste.
  if (browser.info.headful) assert.equal(pasted, "copy me 🙂");
  else console.log(`# headless paste result: ${JSON.stringify(pasted)}`);
  const text = "Hello 世界 — 🙂👍🏽 ok\nline2 日本語";
  await act(page, { action: "type", ref: "e3", value: text });
  assert.equal((await tab.eval("ce.innerText")).replace(/\n+$/, ""), text);
  await act(page, { action: "fill", ref: "e3", value: "替换 ✅" });
  assert.equal((await tab.eval("ce.innerText")).trim(), "替换 ✅");
  await act(page, { action: "type", ref: "e4", value: "Abc!@#" });
  assert.equal(await tab.eval("i1.value"), "Abc!@#");
  await act(page, { action: "press", ref: "e4", keys: "Backspace" });
  assert.equal(await tab.eval("i1.value"), "Abc!@");
  await act(page, { action: "fill", ref: "e4", value: "" });
  assert.equal(await tab.eval("i1.value"), "");
});

test("SPA route change and slow XHR settle without sleeps; real navigation settles", { skip }, async () => {
  const { tab, page } = await agentTab("/spa");
  const spa = await act(page, { action: "click", ref: "e1" });
  assert.equal(spa.settled.kind, "spa");
  assert.equal(await tab.eval("!!document.getElementById('routed')"), true);
  const xhr = await act(page, { action: "click", ref: "e2" });
  assert.equal(await tab.eval("document.getElementById('xhr').textContent"), "xhr done", `settled ${JSON.stringify(xhr.settled)}`);
  const nav = await act(page, { action: "click", ref: "e3" });
  assert.equal(nav.settled.kind, "nav");
  assert.equal(await tab.eval("!!document.getElementById('landed')"), true);
  const back = await navigate(page, { op: "back" });
  assert.ok(["nav", "spa"].includes(back.settled.kind));
  const go = await navigate(page, { url: `${server.origin}/nav-target` });
  assert.equal(go.settled.kind, "nav");
  assert.equal(await tab.eval("location.pathname"), "/nav-target");
  const w = await waitFor(page, { for: "text", text: "Landed", timeoutMs: 2000 });
  assert.equal(w.ok, true);
  await assert.rejects(waitFor(page, { for: "selector", selector: "#nope", timeoutMs: 300 }), (e) => e.code === "timeout");
  console.log(`# settle: spa=${spa.settled.ms}ms xhr=${xhr.settled.ms}ms nav=${nav.settled.ms}ms`);
});

function tmpFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), "obu-wse-up-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

test("upload: fast path, without file-URL access (injection), chooser button, drop zone", { skip }, async () => {
  const { tab, page } = await agentTab("/upload");
  const a = tmpFile("a.txt", "alpha file");
  const b = tmpFile("b.json", '{"b":1}');
  const fast = await act(page, { action: "upload", ref: "e1", files: [a, b] });
  assert.equal(fast.details.upload.mode, "setFileInputFiles");
  await tab.eval("new Promise(r => setTimeout(r, 50))");
  assert.deepEqual((await tab.eval("window.uploaded")).map((f) => f.text), ["alpha file", '{"b":1}']);

  // Simulate chrome.debugger without "Allow access to file URLs".
  tab.interceptSend = (method) => (method === "DOM.setFileInputFiles" ? Promise.reject(new Error("DOM.setFileInputFiles: Not allowed")) : undefined);
  const big = tmpFile("big.bin", Buffer.alloc(1_300_000, 7));
  const inj = await act(page, { action: "upload", ref: "e1", files: [a, big] });
  assert.equal(inj.details.upload.mode, "inject-input");
  await tab.eval("new Promise(r => setTimeout(r, 100))");
  const up = await tab.eval("window.uploaded.map(f => ({name: f.name, size: f.size, type: f.type}))");
  assert.deepEqual(up, [{ name: "a.txt", size: 10, type: "text/plain" }, { name: "big.bin", size: 1_300_000, type: "application/octet-stream" }]);

  const chooser = await act(page, { action: "upload", ref: "e2", files: [b] });
  await tab.eval("new Promise(r => setTimeout(r, 100))");
  assert.equal(chooser.details.upload.mode, "inject-input");
  assert.equal(await tab.eval("document.getElementById('hiddenfile').files[0].name"), "b.json");

  const drop = await act(page, { action: "upload", ref: "e3", files: [a] });
  assert.equal(drop.details.upload.mode, "inject-drop");
  await tab.eval("new Promise(r => setTimeout(r, 100))");
  assert.equal((await tab.eval("window.uploaded"))[0].text, "alpha file");
  tab.interceptSend = null;
});

test("concurrent downloads: each path belongs to the tab that triggered it", { skip }, async () => {
  const one = await agentTab("/download?name=one&delay=300");
  const two = await agentTab("/download?name=two&delay=0");
  const [r1, r2] = await Promise.all([act(one.page, { action: "click", ref: "e1" }), act(two.page, { action: "click", ref: "e1" })]);
  assert.ok(r1.ok && r2.ok);
  const [d1, d2] = await Promise.all([waitFor(one.page, { for: "download", timeoutMs: 10000 }), waitFor(two.page, { for: "download", timeoutMs: 10000 })]);
  assert.equal(d1.download.tabId, one.tab.tabId);
  assert.equal(d2.download.tabId, two.tab.tabId);
  assert.match(readFileSync(d1.download.path, "utf8"), /^contents of one/);
  assert.match(readFileSync(d2.download.path, "utf8"), /^contents of two/);
  assert.ok(one.tab.events.some((e) => e.type === "download_finished"));
});

test("screenshots of a background tab: jpeg/webp/ref/fullPage, always < 3 s", { skip }, async () => {
  const { page } = await agentTab("/click");
  const times = [];
  for (const params of [{}, { format: "webp" }, { ref: "e2" }, { fullPage: true }, { format: "png", maxWidth: 640 }]) {
    const t0 = performance.now();
    const s = await screenshot(page, params);
    const ms = performance.now() - t0;
    times.push(ms);
    assert.ok(ms < 3000, `screenshot ${JSON.stringify(params)} took ${ms}`);
    assert.ok(statSync(s.path).size > 500);
    assert.ok(s.width > 0 && s.width <= (params.maxWidth ?? 1280), `width ${s.width}`);
    console.log(`# screenshot ${JSON.stringify(params)} ${ms.toFixed(0)}ms via=${s.via} ${s.width}x${s.height} ${s.mime}`);
  }
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    await screenshot(page, {});
    times.push(performance.now() - t0);
  }
  console.log(`# background screenshot p50=${percentile(times, 50).toFixed(0)}ms p95=${percentile(times, 95).toFixed(0)}ms`);
});

test("drag (HTML5 + pointer), scroll, iframes (same-origin + OOPIF), shadow DOM, dialogs", { skip }, async () => {
  const { tab, page } = await agentTab("/drag");
  const d = await act(page, { action: "drag", ref: "e1", to: { ref: "e2" } });
  assert.equal(d.details.dropped, true);
  assert.equal(await tab.eval("dz.textContent"), "dropped card-1");
  await act(page, { action: "drag", ref: "e3", to: { coords: { x: 515, y: 215 } } });
  assert.match(await tab.eval("sl.textContent"), /moved to 50\d/);

  const s = await agentTab("/scroll");
  const r = await act(s.page, { action: "scroll", ref: "e1", value: "down" });
  assert.equal(r.details.scroll.target, "div");
  assert.ok((await s.tab.eval("box.scrollTop")) > 0);
  await act(s.page, { action: "scroll" });
  assert.ok((await s.tab.eval("scrollY")) > 0);

  const f = await agentTab(`/frames?cross=${encodeURIComponent(server.crossOrigin)}`);
  await new Promise((res) => setTimeout(res, 300));
  const frames = await f.tab.frames();
  assert.equal(frames.length, 3, "main + same-origin + OOPIF");
  await act(f.page, { action: "click", ref: "f1e1" });
  await act(f.page, { action: "click", ref: "f2e1" });
  const texts = await Promise.all(frames.slice(1).map((fr) => f.tab.browser.cdp.send("Runtime.evaluate", { expression: "document.getElementById('r').textContent", contextId: fr.utilityContextId, returnByValue: true }, fr.sessionId ?? f.tab.sessionId)));
  assert.deepEqual(texts.map((t) => t.result.value), ["same clicked", "cross clicked"]);

  const sh = await agentTab("/shadow");
  await act(sh.page, { action: "click", ref: "e1" });
  assert.equal(await sh.tab.eval("document.getElementById('host').shadowRoot.getElementById('s').textContent"), "shadow clicked");

  const dl = await agentTab("/dialog");
  const a = await act(dl.page, { action: "click", ref: "e1" });
  assert.ok(a.ok);
  assert.equal(await dl.tab.eval("d.textContent"), "after alert");
  const pending = waitFor(dl.page, { for: "dialog", dialogAction: { accept: false }, timeoutMs: 5000 });
  await act(dl.page, { action: "click", ref: "e2" });
  const w = await pending;
  assert.equal(w.event.dialogType, "confirm");
  assert.equal(await dl.tab.eval("c.textContent"), "false");
  await userForegroundUnchanged();
});
