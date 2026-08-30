/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const path = require("node:path");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");

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
