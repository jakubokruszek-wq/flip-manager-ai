/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const migration = fs.readFileSync(path.join(__dirname, "../../supabase/migrations/20260906120000_add_on_demand_facebook_gallery.sql"), "utf8");
const retryMigration = fs.readFileSync(path.join(__dirname, "../../supabase/migrations/20260907090000_atomic_gallery_retry_enqueue.sql"), "utf8");
const galleryJobs = fs.readFileSync(path.join(__dirname, "gallery-jobs.ts"), "utf8");

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

test("gallery retry enqueue is one transaction serialized by the listing row", () => {
  assert.match(retryMigration, /^begin;/m);
  assert.match(retryMigration, /from public\.listings[\s\S]*where id = p_listing_id[\s\S]*for update;/i);
  assert.match(retryMigration, /insert into public\.facebook_scan_jobs[\s\S]*update public\.listings[\s\S]*return query select new_job\.id/i);
  assert.match(retryMigration, /commit;\s*$/i);
});

test("failed retry creates a fresh job while queued or running retries reuse the singleton", () => {
  assert.match(retryMigration, /jobs\.status in \('queued', 'running'\)/);
  assert.doesNotMatch(retryMigration, /jobs\.status in \([^)]*'failed'/);
  assert.match(retryMigration, /'gallery:' \|\| p_listing_id::text \|\| ':' \|\| gen_random_uuid\(\)::text/);
  assert.match(retryMigration, /gallery_job_id = new_job\.id/);
  assert.match(retryMigration, /gallery_status = 'PENDING'/);
  assert.match(retryMigration, /gallery_completed_at = null/);
  assert.match(retryMigration, /gallery_error = null/);
});

test("complete and ineligible listings never enqueue a duplicate gallery job", () => {
  const completeBranch = retryMigration.indexOf("if target.gallery_status = 'COMPLETE'");
  const insertBranch = retryMigration.indexOf("insert into public.facebook_scan_jobs");
  assert.ok(completeBranch >= 0 && completeBranch < insertBranch);
  assert.match(retryMigration, /target\.lifecycle_status in \('REJECTED', 'ARCHIVED', 'STALE'\)/);
  assert.match(retryMigration, /target\.manual_decision = 'REJECTED'/);
});

test("gallery retry preserves listing evidence, images, and business lifecycle", () => {
  const updateClauses = [...retryMigration.matchAll(/update public\.listings([\s\S]*?)where id = p_listing_id;/gi)].map((match) => match[1]).join("\n");
  assert.ok(updateClauses.length > 0);
  assert.doesNotMatch(updateClauses, /\bimages\s*=/i);
  assert.doesNotMatch(updateClauses, /\blifecycle_status\s*=/i);
  assert.doesNotMatch(updateClauses, /\bmanual_decision\s*=/i);
});

test("gallery retry RPC is backend-only and application returns the atomic RPC result", () => {
  assert.match(retryMigration, /revoke all on function public\.enqueue_facebook_gallery_job\(uuid, uuid, text, text\) from public, anon, authenticated;/);
  assert.match(retryMigration, /grant execute on function public\.enqueue_facebook_gallery_job\(uuid, uuid, text, text\) to service_role;/);
  assert.match(galleryJobs, /\.rpc\("enqueue_facebook_gallery_job"/);
  assert.match(galleryJobs, /created: result\?\.job_created === true/);
  assert.doesNotMatch(galleryJobs, /\.from\("facebook_scan_jobs"\)\.insert/);
});

test("failed gallery jobs retain only bounded root diagnostics", () => {
  assert.match(galleryJobs, /sanitizeGalleryDiagnostics/);
  assert.match(galleryJobs, /result_summary: \{ kind: "GALLERY_HYDRATION", status: "FAILED"/);
  assert.match(galleryJobs, /networkRecordPostIds/);
  assert.match(galleryJobs, /expectedRecord/);
  assert.doesNotMatch(galleryJobs, /leaseToken.*diagnostics|diagnostics.*leaseToken/i);
});

test("failed hydration keeps the listing gallery lifecycle monotonic", () => {
  assert.match(galleryJobs, /deriveMonotonicGalleryFailure/);
  assert.match(galleryJobs, /select\("images,gallery_status,gallery_persisted_count,gallery_total"\)/);
  assert.match(galleryJobs, /gallery_status: state\.status/);
  assert.match(galleryJobs, /gallery_persisted_count: state\.persistedTotal/);
  assert.match(galleryJobs, /gallery_total: state\.total/);
  assert.match(galleryJobs, /status: state\.status/);
  assert.match(galleryJobs, /currentStatus: listing\.gallery_status/);
});

test("root-not-found recovery reuses only previously exact-bound metadata", () => {
  assert.match(galleryJobs, /EXACT_ROOT_STORY_METADATA_REUSE/);
  assert.match(galleryJobs, /failureErrorCode: errorCode/);
  assert.match(galleryJobs, /if \(existingImages\.length === 0\) return null/);
  assert.match(galleryJobs, /sourcePostId !== expectedPostId/);
  assert.match(galleryJobs, /storyRootPostId !== expectedPostId/);
  assert.match(galleryJobs, /bindingMethod !== "EXACT_ROOT_STORY"/);
  assert.match(galleryJobs, /classification !== "PROPERTY_IMAGE"/);
  assert.match(galleryJobs, /scontent\[\^\/\]\*\\\.fbcdn\\\.net/);
  assert.doesNotMatch(galleryJobs, /photo fbid.*postId|fbid.*expectedPostId/i);
});
