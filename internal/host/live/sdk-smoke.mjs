// JS SDK against the real relay (token handshake read from active.json dir).
import fs from "node:fs";
import path from "node:path";
import { OpenBrowserUseClient } from "../../../packages/open-browser-use-js/dist/index.js";

const dir = process.env.OBU_LIVE_SOCKET_DIR;
const record = JSON.parse(fs.readFileSync(path.join(dir, "active.json"), "utf8"));
const client = new OpenBrowserUseClient({ socketPath: record.socketPath, tokenPath: record.tokenPath, sessionId: "r2-js-smoke", timeoutMs: 20_000 });
try {
  const info = await client.getInfo();
  if (!info || typeof info !== "object") throw new Error("bad getInfo");
  const tab = await client.request("createTab", { url: process.env.OBU_LIVE_FIXTURE });
  const big = "漢🙂".repeat(700_000); // ~4.2 MB UTF-8 request → chunked to the extension
  const res = await client.request("executeCdp", {
    target: { tabId: tab.id },
    method: "Runtime.evaluate",
    commandParams: { expression: `${JSON.stringify(big)}.length`, returnByValue: true },
    timeoutMs: 20_000
  });
  if (res.result.value !== big.length) throw new Error(`length ${res.result.value} != ${big.length}`);
  await client.request("finalizeTabs", { keep: [] });
  console.log("JS SDK smoke: ok (auth + 4.2MB chunked request)");
} finally {
  client.close();
}
