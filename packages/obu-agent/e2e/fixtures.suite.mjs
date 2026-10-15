// Fixture self-test over raw CDP (no daemon needed): every page loads with no uncaught
// errors, exposes window.__fx, and its page-specific preconditions hold. Runs today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGES } from "../fixtures/pages.mjs";
import { attachPage } from "./lib/cdp.mjs";
import { getEnv, sleep } from "./lib/harness.mjs";

async function openRaw(env, url) {
  const { targetId } = await env.cdp.send("Target.createTarget", { url: "about:blank", background: true });
  const page = await attachPage(env.cdp, targetId);
  const errors = [];
  const off = env.cdp.on((m) => { if (m.sessionId === page.sessionId && m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails); });
  // Raw harness may enable Runtime on its OWN probe tabs (never on agent tabs) to catch page errors.
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  const loaded = env.cdp.waitFor((m) => m.sessionId === page.sessionId && m.method === "Page.loadEventFired", 15_000);
  await page.send("Page.navigate", { url });
  await loaded;
  return { page, errors, targetId, close: async () => { off(); await env.cdp.send("Target.closeTarget", { targetId }).catch(() => {}); } };
}

const CHECKS = {
  "iframes.html": async (p, env) => {
    // OOPIFs are separate targets (not in the main session's frame tree) under site isolation.
    await sleep(300);
    const { targetInfos } = await env.cdp.send("Target.getTargets");
    const oopif = targetInfos.find((x) => x.type === "iframe" && x.url.startsWith(env.fixtures.crossOrigin + "/iframe-form.html"));
    assert.ok(oopif, `cross-origin OOPIF present: ${targetInfos.map((x) => x.type + " " + x.url)}`);
    // The leaf is same-site with the OOPIF, so it lives in the OOPIF's process (not its own target).
    const inner = await attachPage(env.cdp, oopif.targetId);
    try { assert.equal(await inner.evaluate("!!document.getElementById('nested').contentDocument.getElementById('leaf')"), true, "nested leaf inside OOPIF"); }
    finally { await inner.detach(); }
    assert.equal(await p.evaluate("document.getElementById('same').contentDocument.getElementById('holder') !== null"), true, "same-origin frame form reachable");
  },
  "long-list.html": async (p) => assert.ok((await p.evaluate("document.getElementsByTagName('*').length")) >= 2000),
  "infinite-scroll.html": async (p) => { await sleep(600); assert.equal(await p.evaluate("document.querySelectorAll('#feed li').length"), 20); },
  "shadow.html": async (p) => assert.equal(await p.evaluate("!!document.getElementById('open1').shadowRoot && !document.getElementById('closed1').shadowRoot"), true),
  "viewport-probe.html": async (p) => assert.equal(typeof (await p.evaluate("__fx.state.probe.inner[0]")), "number"),
  "datepicker.html": async (p) => { await p.evaluate("document.getElementById('checkout').click()"); assert.match(await p.evaluate("document.getElementById('month').textContent"), /March 2027/); },
  "upload.html": async (p) => assert.equal(await p.evaluate("document.querySelectorAll('input[type=file]').length"), 3),
};

test("fixture pages load cleanly and expose __fx", { timeout: 120_000 }, async (t) => {
  const env = await getEnv();
  if (!env.cdp) return t.skip(env.unavailable ?? "no raw CDP (real-profile mode)");
  for (const { file } of PAGES) {
    await t.test(file, async () => {
      const r = await openRaw(env, env.fixtures.url(file));
      try {
        assert.equal(await r.page.evaluate("typeof window.__fx"), "object");
        await CHECKS[file]?.(r.page, env);
        await sleep(150);
        assert.deepEqual(r.errors.map((e) => e.exception?.description ?? e.text), [], `uncaught errors on ${file}`);
      } finally { await r.close(); }
    });
  }
});

// NOTE: Chrome 153 no longer leaks Runtime.enable through the classic console/Error.stack
// getter probe (verified 2026-10-16 with 7 probe variants), so detect.html is a best-effort
// signal for older Chromes / the user's stable Chrome. The real I8 guard is the daemon's
// own CDP denylist + the sessions e2e test that asserts it.
test("detector page is clean on an untouched tab", { timeout: 30_000 }, async (t) => {
  const env = await getEnv();
  if (!env.cdp) return t.skip("no raw CDP");
  const { targetId } = await env.cdp.send("Target.createTarget", { url: env.fixtures.url("detect.html"), background: true });
  const page = await attachPage(env.cdp, targetId);
  try {
    await sleep(500);
    assert.equal(await page.evaluate("__fx.state.runtimeEnabled"), false, "clean");
  } finally { await env.cdp.send("Target.closeTarget", { targetId }).catch(() => {}); }
});

test("harness: fork extension reaches the dev native host (file-URL access off)", { timeout: 30_000 }, async (t) => {
  const env = await getEnv();
  if (!env.cdp) return t.skip("no CfT (real-profile / attached daemon mode)");
  assert.equal(env.fileUrlAccess, process.env.E2E_FILE_URL_ACCESS === "on");
  const { OpenBrowserUseClient } = await import("../../open-browser-use-js/dist/index.js").catch(() => ({}));
  if (!OpenBrowserUseClient) return t.skip("build open-browser-use-sdk to run this check");
  const c = new OpenBrowserUseClient({ socketPath: env.hostSocket });
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) { try { await c.connect(); break; } catch { await sleep(200); } }
  try {
    const info = await c.request("getInfo", {});
    assert.equal(info.metadata.extensionId, env.extensionId, "extension -> native host -> socket round trip");
  } finally { c.close?.(); }
});
