/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "filter-match-recalculation.ts"), "utf8");

// URGENT ADDITION — production incident: reconcile_canonical_listing_decision
// is service_role-only by design. Proven live against production (read-only,
// a nonexistent-id call so nothing is mutated either way): the
// anon/publishable client gets 42501 "permission denied for function
// reconcile_canonical_listing_decision" — the exact error text observed in
// production as CANONICAL_RECONCILIATION_FAILED — while the same call with
// the service-role key reaches the function body. This function is called
// both by Finder's own scan (scoped to Facebook — see manual-scan.test.cjs)
// and by the admin-secret-protected /recalculate route; both are trusted
// server-side callers and must use the admin client.
test("recalculateFilterMatches uses the service-role admin client, never the anon/publishable one", () => {
  assert.match(source, /import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/, "must import the admin (service-role) client factory");
  assert.doesNotMatch(source, /from ["']@\/lib\/supabase\/server["']/, "must never import the anon/publishable client — it has been explicitly revoked from reconcile_canonical_listing_decision");
  assert.match(source, /const supabase = createAdminClient\(\);/, "the one supabase client this function uses for every read and write (including the reconcileCanonicalListingDecision calls) must be the admin client");
  assert.doesNotMatch(source, /Awaited<ReturnType<typeof createClient>>/, "no leftover type annotation may still reference the old anon-key client factory");
});
