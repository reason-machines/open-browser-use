#!/usr/bin/env node
// Stages a branded copy of the Chrome extension: replaces the @obu-brand block
// in background.js and the user-visible manifest/popup strings from a brand
// JSON, instead of string-patching sources downstream.
//
//   node scripts/package-chrome-extension-brand.mjs --out <dir> [--brand <id>] [--brand-file <json>]
//
// --brand defaults to $OBU_BRAND, then "default" (apps/chrome-extension/brands/<id>.json).
// --brand-file takes any JSON with the same schema (e.g. per-channel product
// identities); an optional "manifestKey" pins the unpacked extension id.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = path.join(REPO_ROOT, "apps", "chrome-extension");
const RUNTIME_FILES = [
  "manifest.json",
  "background.js",
  "content-cursor.js",
  "content-webmcp-main.js",
  "content-webmcp-bridge.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "images/cursor-chat.png",
  "popup.css",
  "popup.html",
  "popup.js"
];
const BRAND_KEYS = ["id", "displayName", "nativeHostName", "groupSuffix", "groupColor", "deliverableGroupTitle"];
const GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const BLOCK = /\/\/ @obu-brand-begin[^\n]*\n(?:\/\/[^\n]*\n)*const BRAND = Object\.freeze\(\{[\s\S]*?\}\);\n\/\/ @obu-brand-end/;

export function loadBrand({ brand, brandFile } = {}) {
  const file = brandFile ?? path.join(EXTENSION_DIR, "brands", `${brand || "default"}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown brand: ${brandFile ?? brand} (${file} not found)`);
  }
  return validateBrand(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function validateBrand(brand) {
  const errors = [];
  for (const key of BRAND_KEYS) {
    if (typeof brand?.[key] !== "string" || !brand[key].trim()) errors.push(`${key} must be a non-empty string`);
  }
  if (brand && !/^[a-z0-9_]+(\.[a-z0-9_]+)*$/.test(brand.nativeHostName ?? "")) {
    errors.push("nativeHostName must be a valid native messaging host name");
  }
  if (brand && !GROUP_COLORS.has(brand.groupColor)) {
    errors.push(`groupColor must be one of ${[...GROUP_COLORS].join(", ")}`);
  }
  if (brand?.manifestKey !== undefined && typeof brand.manifestKey !== "string") {
    errors.push("manifestKey must be a base64 public key string");
  }
  if (errors.length) throw new Error(`Invalid brand: ${errors.join("; ")}`);
  return brand;
}

export function brandBackground(source, brand) {
  if (!BLOCK.test(source)) {
    throw new Error("background.js is missing the @obu-brand-begin/@obu-brand-end block");
  }
  const values = Object.fromEntries(BRAND_KEYS.map((key) => [key, brand[key]]));
  const block = [
    `// @obu-brand-begin — generated from brand "${brand.id}" by scripts/package-chrome-extension-brand.mjs.`,
    `const BRAND = Object.freeze(${JSON.stringify(values, null, 2)});`,
    "// @obu-brand-end"
  ].join("\n");
  return source.replace(BLOCK, block);
}

export function brandManifest(manifest, brand) {
  const out = { ...manifest, name: brand.displayName };
  if (typeof brand.description === "string" && brand.description) out.description = brand.description;
  out.action = { ...(manifest.action ?? {}), default_title: brand.displayName };
  if (brand.manifestKey) out.key = brand.manifestKey;
  return out;
}

export function brandPopup(html, brand) {
  const escaped = brand.displayName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escaped}</title>`)
    .replace(/<h1>[^<]*<\/h1>/, `<h1>${escaped}</h1>`);
}

export function stageBrandedExtension({ out, brand }) {
  fs.mkdirSync(out, { recursive: true });
  for (const file of RUNTIME_FILES) {
    const from = path.join(EXTENSION_DIR, file);
    const to = path.join(out, file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (file === "background.js") {
      fs.writeFileSync(to, brandBackground(fs.readFileSync(from, "utf8"), brand));
    } else if (file === "manifest.json") {
      const manifest = brandManifest(JSON.parse(fs.readFileSync(from, "utf8")), brand);
      fs.writeFileSync(to, `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (file === "popup.html") {
      fs.writeFileSync(to, brandPopup(fs.readFileSync(from, "utf8"), brand));
    } else {
      fs.copyFileSync(from, to);
    }
  }
  return { out, files: RUNTIME_FILES };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--out" || key === "--brand" || key === "--brand-file") {
      if (!value) throw new Error(`${key} requires a value`);
      args[key.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${key}`);
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.out) throw new Error("usage: package-chrome-extension-brand.mjs --out <dir> [--brand <id>] [--brand-file <json>]");
    const brand = loadBrand({ brand: args.brand ?? process.env.OBU_BRAND, brandFile: args["brand-file"] });
    stageBrandedExtension({ out: path.resolve(args.out), brand });
    process.stderr.write(`staged brand ${brand.id} → ${args.out}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
