/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "../../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const component = read("features/settings/components/version-updates-settings.tsx");
const settings = read("features/settings/components/settings-page.tsx");
const serviceWorker = read("components/pwa-service-worker.tsx");
const nextConfig = read("next.config.ts");
const buildInfo = read("app/api/build-info/route.ts");

test("settings compares the browser build with uncached Production build-info", () => {
  assert.match(settings, /<VersionUpdatesSettings \/>/);
  assert.match(component, /NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA/);
  assert.match(component, /fetch\("\/api\/build-info", \{ cache: "no-store" \}\)/);
  assert.match(component, /commitSha/);
  assert.match(component, /Sprawdź aktualizacje/);
  assert.match(component, /Dostępna aktualizacja/);
  assert.match(component, /Aktualizuj/);
  assert.match(buildInfo, /Cache-Control.*no-store/);
  assert.match(nextConfig, /deploymentId: process\.env\.VERCEL_GIT_COMMIT_SHA/);
});

test("PWA update warns before reload and preserves browser storage", () => {
  assert.match(component, /beforeunload/);
  assert.match(component, /window\.confirm\(/);
  assert.match(component, /registration\.update\(\)/);
  assert.match(component, /window\.location\.replace\(/);
  assert.doesNotMatch(component, /localStorage\.clear|sessionStorage\.clear|caches\.delete|indexedDB\.deleteDatabase/);
  assert.match(serviceWorker, /updateViaCache: "none"/);
});

test("version update control remains isolated from Finder, Radar, and Watcher scheduling", () => {
  assert.doesNotMatch(component, /flip-finder|price-radar|facebook-watcher|scan|cron/i);
  assert.match(component, /min-h-11/);
});
