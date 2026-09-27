/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "scan-progress-panel.tsx"), "utf8");

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
