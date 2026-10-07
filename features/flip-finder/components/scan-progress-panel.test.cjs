/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "scan-progress-panel.tsx"), "utf8");

test("routine continuation yields stay out of the user-facing error panel and no fixed interval is promised", () => {
  assert.match(page, /function isNormalYield\(message: string\): boolean/);
  assert.match(page, /\.filter\(\(message\) => !isNormalYield\(message\)\)/);
  assert.doesNotMatch(page, /SOURCE_BUDGET_EXHAUSTED: ready for next portion|SOURCE_SLICE_YIELD: saved progress/);
  assert.doesNotMatch(page, /co.{0,5}5 minut/i);
  assert.doesNotMatch(page, /border-amber-500\/25 bg-amber-500\/10/);
  assert.doesNotMatch(page, /currentSource \?\? "Kolejne źródło"\) \+ " — oczekuje"/);
  assert.match(page, /progress\.status === "partial" && !waiting && technicalMessages\.length === 0/);
});

test("real errors remain visible in Polish and raw diagnostics are behind details", () => {
  assert.match(page, /polishErrorSummary\(technicalMessages\[0\]\)/);
  assert.match(page, /<details className="mt-2 text-xs">/);
  assert.match(page, /Szczeg.*techniczne/);
  assert.match(page, /HTTP\\s\*403\|FORBIDDEN/);
  assert.match(page, /SOURCE_BUDGET_EXHAUSTED\|SOURCE_SLICE_YIELD/);
});

test("the panel shows real stage counts, current source, progress bar, and active work time", () => {
  assert.match(page, /aria-label="Post.*skanowania"/);
  assert.match(page, /czas pracy \{formatDuration\(workTimeMs\)\}/);
  assert.match(page, /completedUnits\}\/\{progress\.overall\.totalUnits/);
  assert.match(page, /role="progressbar"/);
  assert.match(page, /Aktualne.*r.*d.*o/);
  assert.match(page, /progress\.totals\.scanned/);
});

// Production proof (screenshot, 2026-09-27): naming the label "Facebook
// Watcher" instead of bare "Facebook" was NOT enough -- Finder's own scan
// panel was still rendering real per-group Watcher data (group names, post
// counts, collector errors) whenever a filter's lastScan happened to belong
// to the Watcher's own independent scheduler cycle. That was a real runtime
// exposure, not a label problem, so this panel must now be structurally
// incapable of rendering any Facebook group identity or per-group
// breakdown, no matter what the progress payload contains.
test("the panel never renders a Facebook group name, per-group breakdown, or group/post counters", () => {
  assert.doesNotMatch(page, /progress\.current\.groupName/, "must never read a per-run Facebook group name into a label");
  assert.doesNotMatch(page, /progress\.facebook\.groups/, "must never iterate the per-group Facebook breakdown");
  assert.doesNotMatch(page, /progress\.facebook\.(completedGroups|totalGroups)/, "must never render a Facebook group/post completion counter");
  assert.doesNotMatch(page, /Facebook Watcher — grupy/, "the per-group status list heading must not exist in this panel");
  assert.doesNotMatch(page, /aria-label="Facebook Watcher group statuses"/, "the per-group status list must not exist in this panel");
});

test("the facebook source always shows the fixed reconciliation label, regardless of any group name on the payload", () => {
  assert.match(page, /source === "facebook"\s*\n?\s*\?\s*"Facebook — przeliczono z zapisanych ofert"/, "facebook's current-stage label must be the fixed reconciliation string");
});
