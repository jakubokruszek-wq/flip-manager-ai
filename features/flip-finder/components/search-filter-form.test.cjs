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

test("OLX has its own interval field (24/48/72 h) with the Cloudflare limit explained", () => {
  const field = fs.readFileSync(path.join(__dirname, "olx-schedule-field.tsx"), "utf8");
  const schedule = fs.readFileSync(path.join(__dirname, "../finder-schedule.ts"), "utf8");
  assert.match(form, /values\.sources\.includes\("olx"\) \? <OlxScheduleField/);
  assert.match(form, /finderOlxScanIntervalMinutes/);
  assert.match(schedule, /FINDER_OLX_INTERVAL_OPTIONS_MINUTES = \[1440, 2880, 4320\] as const/);
  assert.match(field, /Interwał OLX/);
  assert.match(field, /10 minut przeglądarki na dobę/);
  assert.match(field, /najwyżej 1 skan OLX na 24 h/);
  assert.match(field, /Następny dopuszczalny termin/);
  assert.match(field, /Powód pominięcia/);
  assert.match(field, /olx-schedule`/);
  assert.doesNotMatch(field, /method: "POST"/, "diagnostics are read-only: no retry button");
});
