import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Real production gap: filter-results.ts (Finder's own listing feed) already
 * applies effectiveGalleryDisplayState so a gallery request the extension
 * never claimed reads as a normal, actionable FAILED/timeout state instead
 * of hanging forever -- but the per-listing gallery status endpoint
 * (GET /api/flip-finder/listings/[id]/gallery) called getFacebookGalleryStatus
 * directly, returning the raw, un-overridden DB row. The same PENDING job
 * could therefore read as "still waiting" from this endpoint while Finder's
 * own feed already showed it as failed. Proves the fix: both call sites now
 * agree, by running the real getFacebookGalleryStatus function itself
 * (not a reimplementation) against a controllable fake DB.
 */

type Row = Record<string, unknown>;

function fakeAdmin(listingRow: Row) {
  return {
    from(table: string) {
      assert.equal(table, "listings");
      return {
        select() {
          return {
            eq(_column: string, _id: string) {
              return { async maybeSingle() { return { data: listingRow, error: null }; } };
            },
          };
        },
      };
    },
  };
}

let current = fakeAdmin({});
mock.module("../facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => current } });

const { getFacebookGalleryStatus } = await import("./gallery-jobs.ts");

function listingRow(overrides: Row = {}): Row {
  return {
    id: "listing-1",
    source: "facebook",
    gallery_status: "PENDING",
    gallery_job_id: "job-1",
    gallery_requested_at: new Date().toISOString(),
    gallery_total: 0,
    gallery_persisted_count: 0,
    gallery_error: null,
    ...overrides,
  };
}

test("a gallery request stuck PENDING well past the timeout window reports FAILED/FACEBOOK_GALLERY_TIMEOUT, not an endless PENDING", async () => {
  current = fakeAdmin(listingRow({ gallery_requested_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  const status = await getFacebookGalleryStatus("listing-1");
  assert.equal(status.status, "FAILED");
  assert.equal(status.error, "FACEBOOK_GALLERY_TIMEOUT");
});

test("a gallery request stuck RUNNING well past the timeout window also reports FAILED/FACEBOOK_GALLERY_TIMEOUT", async () => {
  current = fakeAdmin(listingRow({ gallery_status: "RUNNING", gallery_requested_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  const status = await getFacebookGalleryStatus("listing-1");
  assert.equal(status.status, "FAILED");
  assert.equal(status.error, "FACEBOOK_GALLERY_TIMEOUT");
});

test("a genuinely recent PENDING request (well within the timeout window) is never falsely reported as timed out", async () => {
  current = fakeAdmin(listingRow({ gallery_requested_at: new Date(Date.now() - 30 * 1000).toISOString() }));
  const status = await getFacebookGalleryStatus("listing-1");
  assert.equal(status.status, "PENDING");
  assert.equal(status.error, null);
});

test("a COMPLETE gallery is reported unchanged regardless of how long ago it was requested", async () => {
  current = fakeAdmin(listingRow({ gallery_status: "COMPLETE", gallery_requested_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), gallery_total: 5, gallery_persisted_count: 5 }));
  const status = await getFacebookGalleryStatus("listing-1");
  assert.equal(status.status, "COMPLETE");
  assert.equal(status.total, 5);
  assert.equal(status.persistedCount, 5);
});

test("a genuinely FAILED gallery keeps its real error code, never overwritten by the timeout code", async () => {
  current = fakeAdmin(listingRow({ gallery_status: "FAILED", gallery_error: "FACEBOOK_GALLERY_ROOT_AMBIGUOUS", gallery_requested_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }));
  const status = await getFacebookGalleryStatus("listing-1");
  assert.equal(status.status, "FAILED");
  assert.equal(status.error, "FACEBOOK_GALLERY_ROOT_AMBIGUOUS");
});

test("a listing that was never requested at all (NOT_REQUESTED, no requestedAt) is reported as-is, never falsely timed out", async () => {
  current = fakeAdmin(listingRow({ gallery_status: "NOT_REQUESTED", gallery_requested_at: null }));
  const status = await getFacebookGalleryStatus("listing-1");
  assert.equal(status.status, "NOT_REQUESTED");
  assert.equal(status.error, null);
});
