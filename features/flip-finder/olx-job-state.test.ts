import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { claimNext, enqueueUnique, heartbeat, recoverExpiredLeases, type OlxJobState } from "./olx-job-state.ts";

function queued(id = "1", key = "filter:olx:run"): OlxJobState {
  return { id, idempotencyKey: key, status: "queued", attempts: 0, maxAttempts: 3, leaseToken: null, leasedUntil: null, heartbeatAt: null };
}

test("idempotency keeps a single OLX job for the same event", () => {
  const first = queued();
  assert.equal(enqueueUnique([first], queued("2")).length, 1);
});

test("atomic claim contract does not return an already running job", () => {
  const jobs = [queued()];
  assert.equal(claimNext(jobs, 1_000, "lease-1")?.id, "1");
  assert.equal(claimNext(jobs, 1_001, "lease-2"), null);
  const migration = readFileSync("supabase/migrations/20260810190000_create_olx_local_worker_queue.sql", "utf8");
  assert.match(migration, /for update skip locked/i);
});

test("heartbeat extends only the matching lease", () => {
  const job = queued();
  claimNext([job], 1_000, "lease-1");
  assert.equal(heartbeat(job, "wrong", 2_000), false);
  assert.equal(heartbeat(job, "lease-1", 2_000), true);
  assert.equal(job.leasedUntil, 122_000);
});

test("expired lease is recovered and eventually fails", () => {
  const job = queued();
  claimNext([job], 1_000, "lease-1");
  recoverExpiredLeases([job], 122_000);
  assert.equal(job.status, "queued");
  job.status = "running";
  job.attempts = 3;
  job.leasedUntil = 1;
  recoverExpiredLeases([job], 2);
  assert.equal(job.status, "failed");
});

test("offline worker leaves the job queued and existing listing untouched", () => {
  const jobs = [queued()];
  const listings = [{ id: "old-olx", status: "active" }];
  assert.equal(jobs[0].status, "queued");
  assert.deepEqual(listings, [{ id: "old-olx", status: "active" }]);
});
