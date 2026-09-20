import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FakeFacebookSupabase, installFacebookHistorySummaryRpc, installFacebookHistoryClearRpc } from "./server/facebook-fake-supabase.ts";

const MIGRATION_PATH = "supabase/migrations/20260920170000_facebook_watcher_history_preflight_readonly.sql";
const SERVER_PATH = "features/facebook-watcher/server/history-clear.ts";

const LISTING_PURE = "00000000-0000-0000-0000-000000000010";
const LISTING_CROSS = "00000000-0000-0000-0000-000000000011";
const LISTING_PROPERTY = "00000000-0000-0000-0000-000000000012";
const LISTING_DEAL = "00000000-0000-0000-0000-000000000013";
const LISTING_NON_FACEBOOK_SOURCE = "00000000-0000-0000-0000-000000000014";

function seedFixture(db: FakeFacebookSupabase): FakeFacebookSupabase {
  db.seed("listings", [
    { id: LISTING_PURE, source: "facebook" },
    { id: LISTING_CROSS, source: "facebook" },
    { id: LISTING_PROPERTY, source: "facebook" },
    { id: LISTING_DEAL, source: "facebook" },
    // Its own canonical source is OLX; a Facebook post was cross-referenced
    // to it without setting the crossSourceMatch metadata flag. The clear
    // RPC still preserves it because listing_source <> 'facebook' — a
    // preview that only checked the metadata flag would miss this and
    // wrongly report it as safe to permanently delete.
    { id: LISTING_NON_FACEBOOK_SOURCE, source: "olx" },
  ]);
  db.seed("listing_source_metadata", [
    { listing_id: LISTING_PURE, source: "facebook", metadata: {} },
    { listing_id: LISTING_CROSS, source: "facebook", metadata: { crossSourceMatch: true } },
    { listing_id: LISTING_PROPERTY, source: "facebook", metadata: {} },
    { listing_id: LISTING_DEAL, source: "facebook", metadata: {} },
    { listing_id: LISTING_NON_FACEBOOK_SOURCE, source: "facebook", metadata: {} },
  ]);
  db.seed("properties", [{ listing_id: LISTING_PROPERTY }]);
  db.seed("deals", [{ listing_id: LISTING_DEAL }]);
  db.seed("source_scans", []);
  db.seed("facebook_scan_jobs", []);
  return db;
}

const adminUrl = pathToFileURL(path.resolve(import.meta.dirname, "supabase-admin.ts")).href;
let currentDb = new FakeFacebookSupabase();
mock.module(adminUrl, { namedExports: { createFacebookWatcherAdminClient: () => currentDb } });

const { getFacebookWatcherHistorySummary, clearFacebookWatcherHistory } = await import("./server/history-clear.ts");

test("A: preflight never selects public.properties directly from application code", () => {
  const source = fs.readFileSync(path.join(process.cwd(), SERVER_PATH), "utf8");
  assert.doesNotMatch(source, /\.from\("properties"\)/);
  assert.doesNotMatch(source, /\.from\("deals"\)/);
  assert.doesNotMatch(source, /\.from\("listing_source_metadata"\)/);
  assert.match(source, /rpc\("get_facebook_watcher_history_summary"\)/);
});

test("B/C/D: the read-only summary RPC is service_role-only in the migration", () => {
  const migration = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  assert.match(migration, /create or replace function public\.get_facebook_watcher_history_summary/);
  assert.match(migration, /revoke all on function public\.get_facebook_watcher_history_summary\(\) from public, anon, authenticated/);
  assert.match(migration, /grant execute on function public\.get_facebook_watcher_history_summary\(\) to service_role/);
});

test("E: the summary function body contains no mutation and no explicit locking", () => {
  const migration = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  const body = migration.slice(migration.indexOf("create or replace function public.get_facebook_watcher_history_summary"));
  assert.doesNotMatch(body, /\binsert into\b/i);
  assert.doesNotMatch(body, /\bupdate\s+public\./i);
  assert.doesNotMatch(body, /\bdelete from\b/i);
  assert.doesNotMatch(body, /\block table\b/i);
  assert.match(body, /security definer/);
  assert.match(body, /set search_path = public/);
});

test("preview and clear share the exact same classification expression (no drift possible at the SQL level)", () => {
  const clearMigration = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260920160000_facebook_quality_v1_3_2_safety_closure.sql"), "utf8");
  const previewMigration = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  const expression = /\(listing_source <> 'facebook' or cross_source or linked_property or linked_deal\)/;
  assert.match(clearMigration, expression);
  assert.match(previewMigration, expression);
});

test("F/H/I: preview classification matches what the clear RPC would classify, for the same fixture", async () => {
  const previewDb = seedFixture(new FakeFacebookSupabase());
  installFacebookHistorySummaryRpc(previewDb);
  currentDb = previewDb;
  const preview = await getFacebookWatcherHistorySummary();

  const clearDb = seedFixture(new FakeFacebookSupabase());
  installFacebookHistoryClearRpc(clearDb);
  currentDb = clearDb;
  const cleared = await clearFacebookWatcherHistory();

  assert.deepEqual(new Set(preview.pureFacebookListingIds), new Set(cleared.pureFacebookListingIds));
  assert.deepEqual(new Set(preview.preservedListingIds), new Set(cleared.preservedListingIds));
  assert.deepEqual(new Set(preview.removedAssociationListingIds), new Set(cleared.removedAssociationListingIds));

  assert.deepEqual(preview.pureFacebookListingIds, [LISTING_PURE], "the plain Facebook-only listing classifies as pure");
  assert.deepEqual(new Set(preview.preservedListingIds), new Set([LISTING_CROSS, LISTING_PROPERTY, LISTING_DEAL, LISTING_NON_FACEBOOK_SOURCE]), "cross-source, property-linked, deal-linked, and non-Facebook-origin listings are all preserved");
  assert.equal(preview.ready, true);
  assert.equal(preview.blockedReason, null);
});

test("G: an active Facebook source scan blocks preview readiness and blocks a real clear", async () => {
  const previewDb = seedFixture(new FakeFacebookSupabase());
  previewDb.seed("source_scans", [{ id: "scan-1", source: "facebook", status: "running" }]);
  installFacebookHistorySummaryRpc(previewDb);
  currentDb = previewDb;
  const preview = await getFacebookWatcherHistorySummary();
  assert.equal(preview.ready, false);
  assert.equal(preview.blockedReason, "ACTIVE_FACEBOOK_SOURCE_SCAN");

  const clearDb = seedFixture(new FakeFacebookSupabase());
  clearDb.seed("facebook_scan_jobs", [{ id: "job-1", job_type: "SOURCE_SCAN", status: "running" }]);
  installFacebookHistoryClearRpc(clearDb);
  currentDb = clearDb;
  await assert.rejects(clearFacebookWatcherHistory(), /ACTIVE_FACEBOOK_JOB/);
});

test("J: the summary RPC succeeding does not throw FACEBOOK_WATCHER_HISTORY_READ_FAILED", async () => {
  const db = seedFixture(new FakeFacebookSupabase());
  installFacebookHistorySummaryRpc(db);
  currentDb = db;
  await assert.doesNotReject(getFacebookWatcherHistorySummary());
});
