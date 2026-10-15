// r2-repl: transform + sandbox unit tests (fake daemon) and a live multi-step
// flow in ONE repl.run against Chrome for Testing (throwaway profile, port
// 9500-9509). Live part is skipped when no CfT binary is found.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, openStore } from "../dist/index.js";
import { DirectCdpBackend } from "../dist/cdp/direct.js";
import { ReplManager, transformCell } from "../dist/repl/index.js";

// ---------------------------------------------------------------------------
// Unit

describe("repl transform", () => {
  test("top-level declarations become persistent assignments; last expression is returned", () => {
    const out = transformCell("const a = 1; let {b, c: [d]} = o; function f() { return a }\nclass K {}\nawait g(); a + 1");
    assert.match(out, /^f = function f\(\) \{ return a \};/);
    assert.match(out, /\(a = 1\);/);
    assert.match(out, /\(\{b, c: \[d\]\} = o\);/);
    assert.match(out, /K = class K \{\};/);
    assert.match(out, /return \(a \+ 1\);$/);
  });
  test("import is refused with a helpful message", () => {
    assert.throws(() => transformCell("import x from 'y'"), /import\/export are not available/);
  });
  test("syntax errors surface as SyntaxError", () => {
    assert.throws(() => transformCell("const = ;"), SyntaxError);
  });
});

describe("repl sandbox (fake daemon)", () => {
  const calls = [];
  let art;
  const mgr = new ReplManager({
    callFor: (sessionId) => async (method, params) => {
      calls.push({ sessionId, method, params });
      if (method === "tabs.list") return { tabs: [], activeTabId: 7 };
      if (method === "act") return { ok: true, settled: { kind: "dom", ms: 1 }, events: [{ seq: 1, type: "navigation", url: "x", kind: "spa" }] };
      if (method === "evaluate") return { value: params.expression.includes("location.href") ? ["https://x/", "X"] : 42, events: [] };
      if (method === "navigate") return { ok: true, settled: { kind: "nav", ms: 2 }, events: [] };
      if (method === "snapshot") return { tree: '- button "Go" [ref=e3]\n- heading "Hi"', diff: "", url: "https://x/", title: "X", tabId: 7, refCount: 1, warnings: [], events: [] };
      throw new Error(`unexpected ${method}`);
    },
    artifactsDirFor: (sessionId) => (art ??= mkdtempSync(join(tmpdir(), `obu-repl-${sessionId}-`))),
  });
  after(() => art && rmSync(art, { recursive: true, force: true }));

  test("bindings persist across runs and console output is returned", async () => {
    const r1 = await mgr.run("s1", "const n = 20; function twice(x) { return x * 2 }\nconsole.log('n is', n)");
    assert.equal(r1.ok, true, JSON.stringify(r1.error));
    assert.equal(r1.output, "n is 20");
    const r2 = await mgr.run("s1", "console.log(twice(n) + 2); ({ok: true})");
    assert.equal(r2.output, "42");
    assert.match(r2.value, /ok: true/);
  });
  test("sessions are isolated", async () => {
    const r = await mgr.run("s2", "typeof n");
    assert.equal(r.value, "undefined");
  });
  test("ref clicks route to act with the ref; events are collected", async () => {
    calls.length = 0;
    const r = await mgr.run("s1", "await page.click('e3'); await page.getByRole('button', {name: 'Go'}).click(); console.log('done')");
    assert.equal(r.ok, true, JSON.stringify(r.error));
    const acts = calls.filter((c) => c.method === "act");
    assert.equal(acts.length, 2);
    assert.equal(acts[0].params.ref, "e3");
    assert.equal(acts[1].params.ref, "e3");
    assert.equal(acts[0].params.snapshot, "none");
    assert.ok(r.events.some((e) => e.type === "navigation"));
  });
  test("non-interactive role match explains itself", async () => {
    const r = await mgr.run("s1", "await page.getByRole('heading', {name: 'Hi'}).click()");
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "not_actionable");
    assert.match(r.error.message, /not interactive/);
  });
  test("errors keep earlier output; no require/process", async () => {
    const r = await mgr.run("s1", "console.log('before'); typeof require + ' ' + typeof process");
    assert.equal(r.output, "before");
    assert.equal(r.value, "undefined undefined");
    const t = await mgr.run("s1", "console.log('x'); throw new Error('boom')");
    assert.equal(t.ok, false);
    assert.equal(t.output, "x");
    assert.equal(t.error.message, "boom");
  });
  test("fs is confined to ./artifacts", async () => {
    const ok = await mgr.run("s1", "fs.writeFile('./artifacts/a.txt', 'hi'); console.log(fs.readFile('a.txt'))");
    assert.equal(ok.output, "hi", JSON.stringify(ok.error));
    const bad = await mgr.run("s1", "fs.readFile('../../../../etc/passwd')");
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /only be written\/read under \.\/artifacts/);
  });
  test("timeouts cover sync loops and pending promises", async () => {
    const sync = await mgr.run("s1", "while (true) {}", 200);
    assert.equal(sync.ok, false);
    const pending = await mgr.run("s1", "await new Promise(() => {})", 200);
    assert.equal(pending.ok, false);
    assert.equal(pending.error.code, "timeout");
    const after = await mgr.run("s1", "n");
    assert.equal(after.value, "20");
  });
  test("snapshot() prints the tree", async () => {
    const r = await mgr.run("s1", "console.log(await snapshot())");
    assert.match(r.output, /button "Go" \[ref=e3\]/);
  });
});

// ---------------------------------------------------------------------------
// Live (Chrome for Testing)

function findChrome() {
  if (process.env.OBU_CHROME) return process.env.OBU_CHROME;
  const roots = [join(homedir(), "Library/Caches/ms-playwright"), join(homedir(), ".cache/puppeteer/chrome")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root).sort().reverse()) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac-x64"]) {
        const bin = join(root, dir, sub, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
        if (existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

function freePort(from, to) {
  for (let p = from; p <= to; p++) {
    try {
      execFileSync("lsof", ["-nP", `-iTCP:${p}`, "-sTCP:LISTEN"], { stdio: "pipe" });
    } catch {
      return p;
    }
  }
  throw new Error(`no free port in ${from}-${to}`);
}

const PAGES = {
  "/": `<!doctype html><title>Shop</title><h1>Shop</h1>
    <label>Search <input id="q" placeholder="Search products"></label>
    <select id="size" aria-label="Size"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
    <label><input type="checkbox" id="gift"> Gift wrap</label>
    <button id="go" onclick="setTimeout(()=>{document.getElementById('out').textContent='Searched '+q.value+' size '+size.value+(gift.checked?' gift':'');},150)">Search</button>
    <p id="out"></p>
    <a href="/details">Details</a>
    <button onclick="window.open('/popup','_blank')">Open popup</button>
    <a href="/file.csv" download="report.csv">Download report</a>
    <button onclick="document.getElementById('pr').textContent='Prompted: '+prompt('Your name?')">Ask name</button>
    <p id="pr"></p>`,
  "/details": `<!doctype html><title>Details</title><h1>Product details</h1><p id="price">$42</p>
    <ul>${Array.from({ length: 5 }, (_, i) => `<li><button class="add" onclick="this.textContent='Added ${i}'">Add ${i}</button></li>`).join("")}</ul>`,
  "/popup": `<!doctype html><title>Popup</title><h1>Popup page</h1>`,
};

describe("repl live (CfT)", { skip: findChrome() ? false : "Chrome for Testing not found" }, () => {
  let chrome, server, daemon, handlers, tmp, origin;
  const call = (method, params) => handlers[method](params, { connectionId: 1 });

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "obu-repl-live-"));
    server = createServer((req, res) => {
      if (req.url === "/file.csv") {
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' });
        return res.end("sku,qty\nA1,3\nB2,5\n");
      }
      const body = PAGES[req.url.split("?")[0]];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body ?? "nope");
    });
    const port = freePort(9500, 9504);
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    origin = `http://127.0.0.1:${port}`;
    const cdpPort = freePort(9505, 9509);
    chrome = spawn(findChrome(), [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${join(tmp, "profile")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--password-store=basic",
      "--headless=new",
      "about:blank",
    ], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    daemon = new Daemon({
      profile: "Default",
      backend: new DirectCdpBackend({ endpoint: `http://127.0.0.1:${cdpPort}` }),
      store: openStore(":memory:"),
      artifactRoot: join(tmp, "artifacts"),
    });
    await daemon.start();
    handlers = daemon.handlers();
    await call("session.open", { sessionId: "repl-live" });
  });

  after(async () => {
    try {
      await call("session.close", { sessionId: "repl-live" });
    } catch {}
    try {
      await daemon?.stop();
    } catch {}
    chrome?.kill("SIGKILL");
    server?.close();
    await new Promise((r) => setTimeout(r, 200));
    rmSync(tmp, { recursive: true, force: true });
  });

  test("multi-step flow in ONE repl.run", async () => {
    const code = `
      await page.goto(${JSON.stringify(origin + "/")});
      await page.getByPlaceholder('Search products').fill('shoes');
      await page.selectOption('#size', 'm');
      await page.check('#gift');
      await page.getByRole('button', { name: 'Search' }).click();
      await page.waitForText('Searched');
      const searched = await page.innerText('#out');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByText('Download report').click()]);
      const csv = await dl.text();
      const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Open popup' }).click()]);
      const popupTitle = await popup.title();
      await popup.close();
      page.waitForEvent('dialog', { accept: true, promptText: 'Ada' });
      await page.getByRole('button', { name: 'Ask name' }).click();
      const prompted = await page.innerText('#pr');
      await page.getByRole('link', { name: 'Details' }).click();
      await page.locator('button.add').nth(2).click();
      const snap = await snapshot({ interactive: true });
      const shot = await page.screenshot({ path: 'details.jpg' });
      console.log(JSON.stringify({ searched, csvRows: csv.trim().split('\\n').length, popupTitle, prompted, url: page.url(), shotBytes: shot.length }));
      console.log(String(snap));
    `;
    const r = await call("repl.run", { sessionId: "repl-live", code, timeoutMs: 60_000 });
    assert.equal(r.ok, true, `${JSON.stringify(r.error)}\n${r.output}`);
    const facts = JSON.parse(r.output.split("\n")[0]);
    assert.equal(facts.searched, "Searched shoes size m gift");
    assert.equal(facts.csvRows, 3);
    assert.equal(facts.popupTitle, "Popup");
    assert.equal(facts.prompted, "Prompted: Ada");
    assert.match(facts.url, /\/details$/);
    assert.ok(facts.shotBytes > 1000);
    assert.match(r.output, /button "Added 2"/);
    assert.ok(existsSync(join(r.artifactsDir, "details.jpg")));
    // The repl owns no tab bookkeeping of its own: the session's tabs are the daemon's.
    const tabs = await call("tabs.list", { sessionId: "repl-live" });
    assert.equal(tabs.tabs.length, 1, JSON.stringify(tabs.tabs));
  });

  test("bindings persist into the next call; stale refs are typed errors", async () => {
    const r = await call("repl.run", { sessionId: "repl-live", code: "console.log(typeof searched, page.url().endsWith('/details'))" });
    assert.equal(r.output, "string true");
    const stale = await call("repl.run", { sessionId: "repl-live", code: "await page.click('e9999')" });
    assert.equal(stale.ok, false);
    assert.ok(["stale_ref", "not_actionable"].includes(stale.error.code), JSON.stringify(stale.error));
  });

  test("repl.reset drops bindings", async () => {
    await call("repl.reset", { sessionId: "repl-live" });
    const r = await call("repl.run", { sessionId: "repl-live", code: "typeof searched" });
    assert.equal(r.value, "undefined");
  });
});
