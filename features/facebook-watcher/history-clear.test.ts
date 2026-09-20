import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { planFacebookWatcherHistoryClear } from "./history-clear.ts";

test("Watcher clear removes pure Facebook listings but preserves cross-source and CRM records", () => {
  assert.deepEqual(planFacebookWatcherHistoryClear([
    { listingId: "pure" }, { listingId: "cross", crossSourceMatch: true }, { listingId: "crm", linkedProperty: true }, { listingId: "deal", linkedDeal: true },
  ]), { pureFacebookListingIds: ["pure"], preservedListingIds: ["cross", "crm", "deal"], removedAssociationListingIds: ["cross", "crm", "deal"] });
});

test("Watcher clear uses one locked service-role transaction", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "features/facebook-watcher/server/history-clear.ts"), "utf8");
  const migration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260920160000_facebook_quality_v1_3_2_safety_closure.sql"), "utf8");
  assert.match(source, /rpc\("clear_facebook_watcher_history_atomic"/);
  assert.doesNotMatch(source, /\.from\("listings"\)\.delete/);
  assert.match(migration, /create or replace function public\.clear_facebook_watcher_history_atomic/);
  assert.match(migration, /lock table public\.source_scans, public\.facebook_scan_jobs, public\.listings/);
  assert.match(migration, /ACTIVE_FACEBOOK_WORK/);
  assert.match(migration, /revoke all on function public\.clear_facebook_watcher_history_atomic/);
});
