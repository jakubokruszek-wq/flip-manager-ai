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
const deploymentId = require("../deployment-id.mjs").resolveNextDeploymentId;

test("settings compares the browser build with uncached Production build-info", () => {
  assert.match(settings, /<VersionUpdatesSettings \/>/);
  assert.match(component, /NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA/);
  assert.match(component, /fetch\("\/api\/build-info", \{ cache: "no-store" \}\)/);
  assert.match(component, /commitSha/);
  assert.match(component, /Sprawdź aktualizacje/);
  assert.match(component, /Dostępna aktualizacja/);
  assert.match(component, /Aktualizuj/);
  assert.match(buildInfo, /Cache-Control.*no-store/);
  assert.match(nextConfig, /deploymentId: resolveNextDeploymentId\(process\.env\)/);
  assert.match(nextConfig, /NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA/);
});

test("Next deployment IDs are unique-safe Vercel identifiers no longer than 32 chars", () => {
  const platformId = "dpl_" + "a".repeat(27);
  assert.equal(
    deploymentId({ VERCEL_DEPLOYMENT_ID: platformId, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }),
    "a".repeat(27),
  );

  const fromCommit = deploymentId({ VERCEL_GIT_COMMIT_SHA: "b".repeat(40) });
  assert.equal(fromCommit, "b".repeat(32));
  assert.ok(fromCommit.length <= 32);
  assert.doesNotMatch(fromCommit, /^dpl_/);

  assert.equal(
    deploymentId({ VERCEL_DEPLOYMENT_ID: "dpl_" + "x".repeat(33), VERCEL_GIT_COMMIT_SHA: "c".repeat(40) }),
    "c".repeat(32),
  );
  assert.equal(deploymentId({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "d".repeat(40) }), undefined);
  assert.equal(deploymentId({}), undefined);
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
