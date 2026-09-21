/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "scan-progress-panel.tsx"), "utf8");

// Watcher data quality mission: the scan-progress panel's own Facebook
// telemetry (current stage, group-completion metric, per-group status list)
// previously labeled itself bare "Facebook", reading as if Flip Finder were
// itself mid-scan of Facebook rather than reporting on the separate
// Facebook Watcher/Collector pipeline's work.
test("every live Facebook progress label names the Watcher, not a bare source name", () => {
  assert.match(page, /`Facebook Watcher · \$\{progress\.current\.groupName\}`/, "the active-group current-stage label must say Facebook Watcher");
  assert.match(page, /<ProgressDetail label="Facebook Watcher" value=\{`\$\{progress\.facebook\.completedGroups\}/, "the groups/posts completion metric must say Facebook Watcher");
  assert.match(page, /aria-label="Facebook Watcher group statuses"/, "the per-group status list's aria-label must say Facebook Watcher");
  assert.match(page, /Facebook Watcher — grupy/, "the per-group status list's visible heading must say Facebook Watcher");
  assert.match(page, /function sourceLabel\(source: string\): string \{ return source === "olx" \? "OLX" : source === "otodom" \? "Otodom" : source === "morizon" \? "Morizon" : "Facebook Watcher"; \}/, "the fallback label (used when no group name is available yet) must also say Facebook Watcher, so it never reads inconsistently with the group-name variant above");
  assert.doesNotMatch(page, /"Facebook"/, "no remaining bare \"Facebook\" string literal should exist in this panel's labels");
});
