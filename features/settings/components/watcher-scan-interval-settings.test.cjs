/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const component = read("features/settings/components/watcher-scan-interval-settings.tsx");
const route = read("app/api/facebook-watcher/scheduler-settings/route.ts");
const page = read("features/settings/components/settings-page.tsx");
const scheduler = read("features/facebook-worker/scheduler.ts");

test("Settings exposes one global persisted Watcher interval, not a per-group control", () => {
  assert.match(component, /\/api\/facebook-watcher\/scheduler-settings/);
  assert.match(component, /Czas między skanami Watchera/);
  assert.match(component, /Globalny czas pomiędzy kolejnymi cyklami/);
  assert.match(component, /data-testid="watcher-scan-interval-settings"/);
  assert.match(page, /<WatcherScanIntervalSettings \/>/);
  assert.doesNotMatch(component, /priority|groupId|watchedSourceId/);
});

test("the settings API is operator-protected and persists through the existing filter column", () => {
  assert.match(route, /requireOperator\(\)/);
  assert.match(route, /getWatcherScanIntervalMinutes/);
  assert.match(route, /saveWatcherScanIntervalMinutes/);
  assert.match(scheduler, /scanIntervalMinutes/);
  assert.match(scheduler, /schedulerCooldownMinutes\(context\.filter\.scanIntervalMinutes\)/);
});

test("Finder remains a read/filter surface while Watcher owns scheduling", () => {
  const finder = read("features/flip-finder/components/flip-finder-page.tsx");
  assert.doesNotMatch(finder, /from\(["']facebook_scan_jobs["']/);
  assert.doesNotMatch(finder, /chrome\.(?:tabs|runtime)\./);
});
