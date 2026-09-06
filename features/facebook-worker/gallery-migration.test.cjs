/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(path.join(__dirname, "../../supabase/migrations/20260906120000_add_on_demand_facebook_gallery.sql"), "utf8");

test("gallery migration keeps queue consumer routing atomic and prioritizes manual hydration", () => {
  assert.match(migration, /job_type text not null default 'SOURCE_SCAN'/);
  assert.match(migration, /GALLERY_HYDRATION/);
  assert.match(migration, /gallery_scan_jobs_source_idempotency_unique|facebook_scan_jobs_source_idempotency_unique/);
  assert.match(migration, /gallery_scan_jobs_gallery_active_unique|facebook_scan_jobs_gallery_active_unique/);
  assert.match(migration, /ORDER BY jobs\.priority DESC/i);
  assert.match(migration, /FOR UPDATE SKIP LOCKED/i);
  assert.match(migration, /jobs\.consumer_type = p_consumer_type/);
});

test("gallery migration keeps failed/partial retries independent of listing lifecycle", () => {
  assert.match(migration, /gallery_status text not null default 'NOT_REQUESTED'/);
  assert.match(migration, /gallery_status = 'RUNNING'/);
  assert.match(migration, /listings_gallery_status_check/);
  assert.match(migration, /gallery_listing_id uuid references public\.listings/);
});
