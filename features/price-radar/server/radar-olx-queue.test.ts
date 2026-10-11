import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;
const input = { ownerId: "owner-radar", runId: "run-stopped", leaseToken: "new-radar-token", city: "Łódź" };
let existing: Row | null = null;
let updates: Row[] = [];
let inserts: Row[] = [];

function fakeDb() {
  return {
    from(table: string) {
      assert.equal(table, "olx_scan_jobs");
      let action: "select" | "update" | "insert" = "select";
      let patch: Row = {};
      const filters: Row = {};
      const builder: Row = {
        select: () => builder,
        update: (value: Row) => { action = "update"; patch = value; return builder; },
        insert: (value: Row) => { action = "insert"; inserts.push(value); return builder; },
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        maybeSingle: async () => {
          if (action === "select") return { data: existing ? { ...existing } : null, error: null };
          if (action === "insert") return { data: null, error: { code: "unexpected_insert" } };
          updates.push({ patch: { ...patch }, filters: { ...filters } });
          const matches = existing && Object.entries(filters).every(([key, value]) => existing![key] === value);
          if (!matches) return { data: null, error: null };
          existing = { ...existing, ...patch };
          return { data: { id: existing.id, status: existing.status }, error: null };
        },
        single: async () => ({ data: null, error: { code: "unexpected_insert" } }),
      };
      return builder;
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("queue tests inject a fake DB"); } } });
const { enqueueRadarOlxJob } = await import("./radar-olx-queue.ts");

function reset(status: string, errorCode: string | null, ownerId = input.ownerId, runId = input.runId) {
  updates = [];
  inserts = [];
  existing = { id: "stable-olx-job-id", status, error_code: errorCode, radar_owner_id: ownerId, radar_run_id: runId, idempotency_key: `price-radar:${ownerId}:olx:${runId}`, finished_at: "2026-10-11T12:00:00.000Z", result_summary: { priorResult: "preserve", operatorStopHistory: Array.from({ length: 11 }, (_, index) => ({ stoppedAt: `old-${index}` })) } };
}

test("resuming an OLX source requeues the same stopped job rather than inserting a duplicate", async () => {
  reset("failed", "RADAR_STOPPED_BY_OPERATOR");
  const result = await enqueueRadarOlxJob(input, fakeDb() as never);
  assert.deepEqual(result, { id: "stable-olx-job-id", status: "queued" });
  assert.equal(updates.length, 1);
  assert.equal(inserts.length, 0);
  assert.equal(existing?.id, "stable-olx-job-id");
  assert.equal(existing?.status, "queued");
  assert.equal(existing?.radar_lease_token, input.leaseToken);
  assert.equal((existing?.result_summary as Row).priorResult, "preserve", "requeue preserves the job's previous result history");
  assert.equal(((existing?.result_summary as Row).operatorStopHistory as unknown[]).length, 10, "the appended stop-resume history remains bounded");
  assert.equal((updates[0].filters as Row).idempotency_key, `price-radar:${input.ownerId}:olx:${input.runId}`);
  assert.equal((updates[0].filters as Row).error_code, "RADAR_STOPPED_BY_OPERATOR");
});

test("ordinary terminal OLX failures remain terminal and are not silently retried", async () => {
  reset("failed", "HTTP_403");
  await assert.rejects(enqueueRadarOlxJob(input, fakeDb() as never), /RADAR_OLX_JOB_ALREADY_FAILED/);
  assert.equal(updates.length, 0);
  assert.equal(inserts.length, 0);
});

test("an unrelated owner's or run's stopped job is never adopted", async () => {
  reset("failed", "RADAR_STOPPED_BY_OPERATOR", "other-owner");
  await assert.rejects(enqueueRadarOlxJob(input, fakeDb() as never), /RADAR_OLX_JOB_ALREADY_FAILED/);
  assert.equal(updates.length, 0);
  assert.equal(inserts.length, 0);
});
