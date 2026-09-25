import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../../");
const migrationPath = fs.readdirSync(path.join(root, "supabase/migrations"))
  .filter((name) => /^\d+_harden_listing_lifecycle_rpc\.sql$/.test(name))
  .sort()
  .at(-1);
assert.ok(migrationPath, "the generated lifecycle hardening migration must exist");
const migration = fs.readFileSync(path.join(root, "supabase/migrations", migrationPath), "utf8");

test("lifecycle migration closes public RPC and table UPDATE privileges", () => {
  assert.match(migration, /alter function public\.cleanup_listing_visibility_lifecycle\(timestamptz\)\s+set search_path = public/i);
  assert.match(migration, /revoke execute on function public\.cleanup_listing_visibility_lifecycle\(timestamptz\)\s+from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.cleanup_listing_visibility_lifecycle\(timestamptz\)\s+to service_role/i);
  assert.match(migration, /revoke update on table public\.listings from public, anon, authenticated/i);
  assert.match(migration, /grant update on table public\.listings to service_role/i);
  assert.doesNotMatch(migration, /security definer|execute\s+immediate|\b(drop|delete|truncate)\b/i);
});

test("lifecycle RPC remains invoker-only and server callers are the trusted boundary", () => {
  const visibility = fs.readFileSync(path.join(root, "features/flip-finder/server/visibility-lifecycle.ts"), "utf8");
  const clearRoute = fs.readFileSync(path.join(root, "app/api/flip-finder/search-filters/[id]/clear-results/route.ts"), "utf8");
  const reviewRoute = fs.readFileSync(path.join(root, "app/api/flip-finder/listings/[id]/review/route.ts"), "utf8");
  const clearService = fs.readFileSync(path.join(root, "features/flip-finder/server/clear-results.ts"), "utf8");
  const finderPage = fs.readFileSync(path.join(root, "features/flip-finder/components/flip-finder-page.tsx"), "utf8");
  const inlineResults = fs.readFileSync(path.join(root, "features/flip-finder/components/inline-filter-results.tsx"), "utf8");
  assert.match(visibility, /createFacebookWatcherAdminClient/);
  assert.match(clearRoute, /await requireOperator\(\)/);
  assert.match(reviewRoute, /await requireOperator\(\)/);
  assert.match(clearService, /createAdminClient/);
  assert.doesNotMatch(finderPage, /x-flip-finder-action/);
  assert.doesNotMatch(inlineResults, /x-flip-finder-action/);
  assert.doesNotMatch(finderPage + inlineResults, /SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY/);
  assert.doesNotMatch(clearRoute + reviewRoute + clearService, /createClient\(\)/);
});

test("lifecycle mutations no longer use forgeable browser headers as authorization", () => {
  const clearRoute = fs.readFileSync(path.join(root, "app/api/flip-finder/search-filters/[id]/clear-results/route.ts"), "utf8");
  const reviewRoute = fs.readFileSync(path.join(root, "app/api/flip-finder/listings/[id]/review/route.ts"), "utf8");
  assert.doesNotMatch(clearRoute + reviewRoute, /sec-fetch-site|headers\.get\(["']origin|x-flip-finder-action/);
  assert.match(clearRoute + reviewRoute, /operatorAuthorizationResponse/);
});
