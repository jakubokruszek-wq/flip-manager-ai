import assert from "node:assert/strict";
import test from "node:test";
import { expireUnclaimedOlxJobs } from "./scan-progress.ts";

type OlxJobRow = { id: string; scan_run_id: string; source_scan_id: string; status: string; attempts: number; created_at: string; leased_until: string | null };
type SourceScanRow = { id: string; status: string };

/**
 * OLX watchdog regression (HOLD blocker): an independent review of da7a787
 * proved claim_olx_scan_job's own lease-recovery SQL only runs as a side
 * effect of being CALLED by a live worker -- if no OLX worker process exists
 * at all, a "queued" job that was never claimed, or a "running" job whose
 * worker went silent, has no reaper anywhere and would sit "w toku" forever.
 * This models exactly the query shape expireUnclaimedOlxJobs issues against
 * olx_scan_jobs and source_scans, not a general-purpose Supabase double.
 */
function fakeAdmin(olxJobs: OlxJobRow[], sourceScans: SourceScanRow[]) {
  const client = {
    from(table: string) {
      if (table === "olx_scan_jobs") {
        return {
          update(patch: Record<string, unknown>) {
            const filters: Array<(row: OlxJobRow) => boolean> = [];
            const builder = {
              eq(column: string, value: unknown) { filters.push((row) => (row as unknown as Record<string, unknown>)[column] === value); return builder; },
              lt(column: string, value: string) { filters.push((row) => String((row as unknown as Record<string, unknown>)[column] ?? "") < value); return builder; },
              async select() {
                const matched = olxJobs.filter((row) => filters.every((f) => f(row)));
                for (const row of matched) Object.assign(row, patch);
                return { data: matched.map((row) => ({ source_scan_id: row.source_scan_id })), error: null };
              },
            };
            return builder;
          },
        };
      }
      if (table === "source_scans") {
        return {
          update(patch: Record<string, unknown>) {
            let ids: string[] = [];
            let statusFilter: string[] = [];
            const builder = {
              in(column: string, values: string[]) { if (column === "id") ids = values; else if (column === "status") statusFilter = values; return builder; },
              then(resolve: (value: { error: null }) => void) {
                for (const row of sourceScans) {
                  if (ids.includes(row.id) && statusFilter.includes(row.status)) Object.assign(row, patch);
                }
                resolve({ error: null });
              },
            };
            return builder;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return client;
}

function olxJob(overrides: Partial<OlxJobRow> = {}): OlxJobRow {
  return { id: "job-1", scan_run_id: "run-1", source_scan_id: "scan-1", status: "queued", attempts: 0, created_at: new Date(Date.now() - 5 * 60_000).toISOString(), leased_until: null, ...overrides };
}

test("a never-claimed queued job older than the timeout is failed with OLX_WORKER_CLAIM_TIMEOUT", async () => {
  const jobs = [olxJob()];
  const scans = [{ id: "scan-1", status: "pending" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-1");
  assert.equal(jobs[0].status, "failed");
  assert.equal((jobs[0] as unknown as Record<string, unknown>).error_code, "OLX_WORKER_CLAIM_TIMEOUT");
  assert.equal(scans[0].status, "failed");
});

test("a recently-queued job within the timeout window is left untouched", async () => {
  const jobs = [olxJob({ created_at: new Date(Date.now() - 5_000).toISOString() })];
  const scans = [{ id: "scan-1", status: "pending" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-1");
  assert.equal(jobs[0].status, "queued");
  assert.equal(scans[0].status, "pending");
});

test("a job already claimed at least once (attempts > 0) is never matched by the never-claimed branch", async () => {
  const jobs = [olxJob({ attempts: 1, created_at: new Date(Date.now() - 5 * 60_000).toISOString() })];
  const scans = [{ id: "scan-1", status: "pending" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-1");
  assert.equal(jobs[0].status, "queued", "attempts>0 belongs to the stale-lease branch, not the never-claimed one");
});

test("a running job whose lease expired long ago (no worker alive to recover it) is failed", async () => {
  const jobs = [olxJob({ status: "running", attempts: 1, leased_until: new Date(Date.now() - 5 * 60_000).toISOString() })];
  const scans = [{ id: "scan-1", status: "running" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-1");
  assert.equal(jobs[0].status, "failed");
  assert.equal((jobs[0] as unknown as Record<string, unknown>).error_code, "OLX_WORKER_CLAIM_TIMEOUT");
  assert.equal(scans[0].status, "failed");
});

test("a running job whose lease is still within its window (or just expired) is left untouched", async () => {
  const jobs = [olxJob({ status: "running", attempts: 1, leased_until: new Date(Date.now() + 60_000).toISOString() })];
  const scans = [{ id: "scan-1", status: "running" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-1");
  assert.equal(jobs[0].status, "running");
});

test("repeated polling is idempotent: a second call on an already-failed job is a no-op", async () => {
  const jobs = [olxJob()];
  const scans = [{ id: "scan-1", status: "pending" }];
  const client = fakeAdmin(jobs, scans);
  await expireUnclaimedOlxJobs(client as never, "run-1");
  const firstFinishedAt = (jobs[0] as unknown as Record<string, unknown>).finished_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await expireUnclaimedOlxJobs(client as never, "run-1");
  assert.equal(jobs[0].status, "failed");
  assert.equal((jobs[0] as unknown as Record<string, unknown>).finished_at, firstFinishedAt, "a second poll must never re-touch an already-terminal row");
});

test("a late worker cannot revive an expired job: once failed, the row no longer satisfies claim_olx_scan_job's own status='queued' selection or heartbeat/complete's status='running' guard", async () => {
  const jobs = [olxJob()];
  const scans = [{ id: "scan-1", status: "pending" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-1");
  assert.equal(jobs[0].status, "failed");
  assert.notEqual(jobs[0].status, "queued", "claim_olx_scan_job only selects status='queued' rows");
  assert.notEqual(jobs[0].status, "running", "heartbeatOlxJob/failOlxJob/completeOlxJob all require status='running'");
});

test("only the requested scan_run_id's jobs are ever touched", async () => {
  const jobs = [olxJob({ id: "job-a", scan_run_id: "run-a", source_scan_id: "scan-a" }), olxJob({ id: "job-b", scan_run_id: "run-b", source_scan_id: "scan-b" })];
  const scans = [{ id: "scan-a", status: "pending" }, { id: "scan-b", status: "pending" }];
  await expireUnclaimedOlxJobs(fakeAdmin(jobs, scans) as never, "run-a");
  assert.equal(jobs[0].status, "failed");
  assert.equal(jobs[1].status, "queued", "a different scan_run_id's job must never be touched");
});
