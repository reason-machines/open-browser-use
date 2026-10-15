// Run: node --test scripts/package-chrome-extension-brand.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { brandBackground, loadBrand, stageBrandedExtension, validateBrand } from "./package-chrome-extension-brand.mjs";

function evalBrand(source) {
  const start = source.indexOf("// @obu-brand-begin");
  const end = source.indexOf("// @obu-brand-end");
  return vm.runInNewContext(`${source.slice(start, end)}; BRAND`);
}

test("every shipped brand validates", () => {
  const dir = path.resolve("apps/chrome-extension/brands");
  for (const file of fs.readdirSync(dir)) {
    const brand = loadBrand({ brandFile: path.join(dir, file) });
    assert.equal(`${brand.id}.json`, file);
  }
});

test("default brand block in source matches brands/default.json", () => {
  const source = fs.readFileSync("apps/chrome-extension/background.js", "utf8");
  const inSource = evalBrand(source);
  const brand = loadBrand({ brand: "default" });
  for (const key of Object.keys(inSource)) assert.equal(inSource[key], brand[key], key);
});

test("staging a brand rewrites background, manifest and popup only", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "obu-brand-"));
  try {
    const brand = { ...loadBrand({ brand: "reason" }), manifestKey: "TESTKEY" };
    stageBrandedExtension({ out, brand });
    const background = fs.readFileSync(path.join(out, "background.js"), "utf8");
    const staged = evalBrand(background);
    assert.equal(staged.nativeHostName, "com.reasonmachines.browser_use.extension");
    assert.equal(staged.groupTitle, "Reason");
    assert.equal(staged.deliverableGroupTitle, "Reason");
    assert.ok(!background.includes("com.ifuryst.open_browser_use.extension"));
    new vm.Script(background);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "Reason");
    assert.equal(manifest.action.default_title, "Reason");
    assert.equal(manifest.key, "TESTKEY");
    assert.ok(manifest.permissions.includes("debugger"));
    const popup = fs.readFileSync(path.join(out, "popup.html"), "utf8");
    assert.match(popup, /<title>Reason<\/title>/);
    assert.match(popup, /<h1>Reason<\/h1>/);
    // Re-branding an already branded source works (block stays parseable).
    const twice = brandBackground(background, loadBrand({ brand: "default" }));
    assert.equal(evalBrand(twice).id, "default");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("invalid brands are rejected", () => {
  assert.throws(() => validateBrand({ id: "x" }), /displayName/);
  assert.throws(
    () => validateBrand({ ...loadBrand({ brand: "default" }), nativeHostName: "Bad Host" }),
    /nativeHostName/
  );
  assert.throws(() => validateBrand({ ...loadBrand({ brand: "default" }), groupColor: "teal" }), /groupColor/);
  assert.throws(() => validateBrand({ ...loadBrand({ brand: "default" }), deliverableGroupTitle: "✅ Done" }), /status glyphs/);
  assert.throws(() => brandBackground("const x = 1;", loadBrand({ brand: "default" })), /obu-brand-begin/);
});
