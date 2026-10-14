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
  assert.match(schedule, /FINDER_OLX_INTERVAL_OPTIONS_MINUTES = \[720, 1440, 2880, 4320\] as const/);
  assert.match(schedule, /FINDER_OLX_TIME_ZONE = "Europe\/Warsaw"/);
  assert.match(schedule, /FINDER_OLX_DEFAULT_START_TIME = "08:00"/);
  assert.match(form, /onStartTimeChange=\{\(finderOlxStartTime\)/);
  assert.match(field, /Interwał OLX/);
  assert.match(field, /Godzina startu OLX \(czas polski\)/);
  assert.match(field, /10 minut przeglądarki na dobę/);
  assert.match(field, /bez nadrabiania/);
  assert.match(field, /Ostatni termin/);
  assert.match(field, /rzeczywisty start/);
  assert.match(field, /opóźnienie/);
  assert.match(field, /Następny termin/);
  assert.match(field, /Status Workera/);
  assert.match(field, /Budżet przeglądarki Cloudflare/);
  assert.match(field, /Powód pominięcia/);
  assert.match(field, /olx-schedule`/);
  assert.doesNotMatch(field, /method: "POST"/, "diagnostics are read-only: no retry button");
});
