import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Retry bounding gap: enqueue_facebook_gallery_job/repair_facebook_gallery_job
 * are already idempotent (a listing row lock + partial unique index prevent
 * two active jobs at once), but nothing capped how many times an operator
 * could click "Napraw galerię" against a listing whose gallery can never
 * succeed (e.g. a deleted Facebook post) -- each call was safe, but unbounded
 * in count. This proves repairFacebookGalleryJob now refuses once
 * FACEBOOK_GALLERY_REPAIR_MAX_ATTEMPTS prior GALLERY_HYDRATION jobs already
 * exist for the listing, using only the existing facebook_scan_jobs table
 * (no new column/migration).
 */

type Row = Record<string, unknown>;

function fakeAdmin(priorAttemptCount: number, rpcResult: { data: Row | null; error: { message: string } | null } = { data: { gallery_job_id: "job-new", expected_post_id: "post-1", listing_id: "listing-1" }, error: null }) {
  const rpcCalls: string[] = [];
  return {
    rpcCalls,
    client: {
      from(table: string) {
        assert.equal(table, "facebook_scan_jobs");
        return {
          select(_columns: string, _opts: { count: string; head: boolean }) {
            return {
              eq(_c1: string, _v1: string) {
                return { eq: (_c2: string, _v2: string) => Promise.resolve({ count: priorAttemptCount, error: null }) };
              },
            };
          },
        };
      },
      rpc(name: string, _params: Record<string, unknown>) {
        rpcCalls.push(name);
        return { single: async () => rpcResult };
      },
    },
  };
}

let current = fakeAdmin(0);
mock.module("../facebook-watcher/supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => current.client } });

const { repairFacebookGalleryJob, FACEBOOK_GALLERY_REPAIR_MAX_ATTEMPTS } = await import("./gallery-jobs.ts");

test("a listing with fewer prior GALLERY_HYDRATION attempts than the limit can still be repaired", async () => {
  current = fakeAdmin(FACEBOOK_GALLERY_REPAIR_MAX_ATTEMPTS - 1);
  const result = await repairFacebookGalleryJob("listing-1");
  assert.equal(result.jobId, "job-new");
  assert.deepEqual(current.rpcCalls, ["repair_facebook_gallery_job"], "the real repair RPC must still be called when under the limit");
});

test("a listing that has already reached the attempt limit is refused before the repair RPC is ever called", async () => {
  current = fakeAdmin(FACEBOOK_GALLERY_REPAIR_MAX_ATTEMPTS);
  await assert.rejects(() => repairFacebookGalleryJob("listing-1"), /FACEBOOK_GALLERY_REPAIR_LIMIT_REACHED/);
  assert.deepEqual(current.rpcCalls, [], "the repair RPC must never run once the attempt limit is reached");
});

test("a listing over the limit (e.g. from a lower limit configured earlier) is also refused, never allowed through", async () => {
  current = fakeAdmin(FACEBOOK_GALLERY_REPAIR_MAX_ATTEMPTS + 3);
  await assert.rejects(() => repairFacebookGalleryJob("listing-1"), /FACEBOOK_GALLERY_REPAIR_LIMIT_REACHED/);
});
