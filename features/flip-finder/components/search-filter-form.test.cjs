/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const form = fs.readFileSync(path.join(__dirname, "search-filter-form.tsx"), "utf8");
const contract = fs.readFileSync(path.join(__dirname, "../search-filter-contract.ts"), "utf8");

test("unavailable legacy source checkboxes are disabled and visibly marked", () => {
  assert.match(contract, /disabled: !isActiveFilterSource\(option\.value\)/);
  assert.match(form, /const disabledSourceOptions = SEARCH_FILTER_SOURCE_OPTIONS\.filter\(\(option\) => option\.disabled\)/);
  assert.match(form, /disabled=\{disabled\}/);
  assert.match(form, /data-source-disabled=\{disabled \? "true" : undefined\}/);
  assert.match(form, /cursor-not-allowed opacity-60/);
});
