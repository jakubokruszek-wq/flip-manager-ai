/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const finderServer = fs.readFileSync(path.join(root, "flip-finder/server/filter-results.ts"), "utf8");
const finderCards = fs.readFileSync(path.join(root, "flip-finder/components/inline-filter-results.tsx"), "utf8");
const finderPage = fs.readFileSync(path.join(root, "flip-finder/components/filter-results-page.tsx"), "utf8");
const watcherServer = fs.readFileSync(path.join(root, "facebook-watcher/server.ts"), "utf8");
const watcherPanel = fs.readFileSync(path.join(root, "facebook-watcher/components/facebook-watcher-panel.tsx"), "utf8");

test("Finder reads source_post_url in one batched metadata query and keeps the canonical listing id", () => {
  assert.match(finderServer, /select\("listing_id,source_post_url,(?:collected_at,)?published_at,metadata"\)/);
  assert.match(finderServer, /sourcePostUrlByListingId/);
  assert.match(finderServer, /resolveListingUrl\(\{ source: listing\.source/);
  assert.match(finderServer, /id: listing\.id/);
  assert.doesNotMatch(finderServer, /from\("facebook_scan_jobs"\)/);
});

test("Watcher and Finder cards use the shared resolver and never render raw nullable URLs", () => {
  assert.match(watcherServer, /sourcePostUrl: facebookUrl/);
  assert.match(watcherServer, /resolveListingUrl\(\{ source: "facebook"/);
  assert.match(watcherPanel, /resolveListingUrl\(\{source:"facebook"/);
  assert.match(finderCards, /resolveListingUrl\(\{ source: result\.source/);
  assert.match(finderPage, /resolveListingUrl\(\{ source: result\.source/);
  assert.doesNotMatch(finderCards, /href=\{result\.originalUrl\}/);
  assert.doesNotMatch(finderPage, /href=\{result\.originalUrl\}/);
  assert.match(finderCards, /Brak prawidłowego linku do ogłoszenia/);
  assert.match(finderPage, /Brak prawidłowego linku do ogłoszenia/);
});
