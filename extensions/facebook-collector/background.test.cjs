/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
const pairing = fs.readFileSync(path.join(__dirname, "pairing.js"), "utf8");
const options = fs.readFileSync(path.join(__dirname, "options.js"), "utf8");
const optionsHtml = fs.readFileSync(path.join(__dirname, "options.html"), "utf8");

test("declares scripting permission for bounded fallback injection", () => {
  assert.ok(manifest.permissions.includes("scripting"));
  assert.match(background, /chrome\.scripting\.executeScript/);
  assert.match(background, /attempt === 10/);
});

test("production active-source flow is allowlisted, deep, single-click and bounded", () => {
  assert.match(background, /lodzsprzedazzakupwynajem/);
  assert.match(background, /minScrolls: 5/);
  assert.match(background, /maxScrolls: 30/);
  assert.match(background, /hardTimeBudgetMs: 110_000/);
  assert.match(background, /ACTIVE_SEARCH_QUERIES/);
  assert.match(background, /PRODUCTION_SOURCE_NOT_ALLOWED/);
  assert.match(background, /importScripts\("collector-core\.js"\)/);
});

test("pairing status autoload uses signed backend verification in popup and setup", () => {
  assert.match(background, /GET_PAIRING_STATUS/);
  assert.match(background, /VERIFY_PAIRING_STATUS/);
  assert.match(background, /signedPost\(`\$\{apiUrl\}\/api\/collector\/heartbeat`/);
  assert.match(popup, /void loadPairingStatus\(\)/);
  assert.match(pairing, /FLIP_COLLECTOR_STATUS_REQUEST/);
  assert.match(pairing, /FLIP_COLLECTOR_STATUS_RESULT/);
});

test("extension UI never reads or renders the device token", () => {
  assert.doesNotMatch(popup, /deviceToken/);
  assert.doesNotMatch(options, /deviceToken/);
  assert.doesNotMatch(optionsHtml, /deviceToken|Device token/i);
  assert.match(pairing, /deviceToken: data\.deviceToken/);
  assert.doesNotMatch(pairing, /FLIP_COLLECTOR_STATUS_RESULT[\s\S]{0,500}deviceToken/);
});
