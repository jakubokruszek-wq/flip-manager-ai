/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "group-discovery-bridge.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

test("the bridge is registered only on the real Manager groups page, on both desktop and localhost", () => {
  const entry = manifest.content_scripts.find((item) => item.js.includes("group-discovery-bridge.js"));
  assert.ok(entry, "group-discovery-bridge.js must be a registered content script");
  assert.deepEqual(new Set(entry.matches), new Set(["https://flip-manager-ai.vercel.app/facebook-watcher/groups*", "http://localhost:3000/facebook-watcher/groups*"]));
});

test("the bridge only reacts to messages from this exact window, on an allowed origin", () => {
  assert.match(source, /event\.source !== window \|\| !ALLOWED_ORIGINS\.has\(event\.origin\)/);
  assert.match(source, /ALLOWED_ORIGINS = new Set\(\["https:\/\/flip-manager-ai\.vercel\.app", "http:\/\/localhost:3000"\]\)/);
});

test("a request is acknowledged immediately, before the extension does anything else", () => {
  const body = source.match(/window\.addEventListener\("message", \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(body, "the request listener must exist");
  const ackIndex = body.indexOf("FLIP_GROUP_DISCOVERY_ACK");
  const sendIndex = body.indexOf("chrome.runtime.sendMessage");
  assert.ok(ackIndex >= 0 && sendIndex > ackIndex, "the ACK must be posted before the extension runtime call starts");
});

test("the final result and any runtime failure both reach the page via FLIP_GROUP_DISCOVERY_RESULT, never silently swallowed", () => {
  assert.match(source, /window\.postMessage\(\{ type: "FLIP_GROUP_DISCOVERY_RESULT", \.\.\.publicResult\(response\) \}, event\.origin\)/);
  assert.match(source, /window\.postMessage\(\{ type: "FLIP_GROUP_DISCOVERY_RESULT", ok: false, error: normalizeRuntimeError\(runtimeError\) \}, event\.origin\)/);
  assert.match(source, /\} catch \(error\) \{\s*window\.postMessage\(\{ type: "FLIP_GROUP_DISCOVERY_RESULT", ok: false, error: normalizeRuntimeError\(error\) \}, event\.origin\);/);
});

test("progress pushes from background.js are relayed to the page as they happen", () => {
  assert.match(source, /chrome\.runtime\.onMessage\.addListener\(\(message\) => \{/);
  assert.match(source, /message\?\.type !== "GROUP_DISCOVERY_PROGRESS"/);
  assert.match(source, /window\.postMessage\(\{ type: "FLIP_GROUP_DISCOVERY_PROGRESS", stage: message\.stage \}, window\.location\.origin\)/);
});

test("publicResult never forwards anything beyond the documented, whitelisted fields", () => {
  const body = source.match(/function publicResult\(value\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(body);
  assert.match(body, /ok: value\?\.ok === true/);
  assert.match(body, /token: typeof value\?\.token === "string" \? value\.token : undefined/);
  assert.match(body, /expiresAt: typeof value\?\.expiresAt === "string" \? value\.expiresAt : undefined/);
  assert.match(body, /error: typeof value\?\.error === "string" \? value\.error : undefined/);
});
