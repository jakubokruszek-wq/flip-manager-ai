import assert from "node:assert/strict";
import { mock, test } from "node:test";

/** claim-scheduled: payload, mapping, fail-closed parsing; expiry and monitoring helpers. */
const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: null, error: null };

mock.module("server-only", { defaultExport: {} });
mock.module("@/features/flip-finder/server/olx-worker-admin", {
  namedExports: { createOlxWorkerAdminClient: () => ({ rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpcResult; } }) },
});

const { claimScheduledOlxJob, parseScheduledClaim, parseScheduledClaimBody, expireStaleScheduledOlxJobs, getOlxAutomationStatus } = await import("./olx-scheduled-claim.ts");

const job = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", scan_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", source_scan_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  search_filter_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", context_type: "finder", requested_by: "scheduler", status: "running",
  request_url: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", lease_token: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", leased_until: "2026-10-15T07:47:00Z", attempts: 1,
};

test("payload is exactly { workerId }: no job id, filter or other selector", () => {
  assert.deepEqual(parseScheduledClaimBody({ workerId: "cloudflare-olx-scheduled" }), { workerId: "cloudflare-olx-scheduled" });
  assert.throws(() => parseScheduledClaimBody({ workerId: "cloudflare-olx-scheduled", jobId: job.id }), /INVALID_SELECTOR/);
  assert.throws(() => parseScheduledClaimBody({ workerId: "cloudflare-olx-scheduled", filterId: "x" }), /INVALID_SELECTOR/);
  assert.throws(() => parseScheduledClaimBody({}), /INVALID_PAYLOAD/);
  assert.throws(() => parseScheduledClaimBody(null), /INVALID_PAYLOAD/);
});

test("calls only claim_scheduled_finder_olx_job and maps the job; reasons pass through", async () => {
  calls.length = 0;
  rpcResult = { data: { job, reason: null }, error: null };
  const claimed = await claimScheduledOlxJob("cloudflare-olx-scheduled");
  assert.deepEqual(calls, [{ fn: "claim_scheduled_finder_olx_job", args: { p_worker_id: "cloudflare-olx-scheduled", p_lease_seconds: 120 } }]);
  assert.equal(claimed.job?.id, job.id);
  assert.equal(claimed.job?.contextType, "finder");
  assert.equal(claimed.job?.radarRunLeaseToken, null);
  for (const reason of ["AUTOMATION_DISABLED", "OLX_JOB_RUNNING", "DAILY_CLAIM_USED", "NO_DUE_JOB"]) {
    rpcResult = { data: { job: null, reason }, error: null };
    assert.deepEqual(await claimScheduledOlxJob("cloudflare-olx-scheduled"), { job: null, reason });
  }
});

test("fails closed: missing function, unknown reason, non-automatic or Radar job, garbage", async () => {
  rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
  await assert.rejects(claimScheduledOlxJob("cloudflare-olx-scheduled"), /OLX_SCHEDULED_CLAIM_UNAVAILABLE/);
  rpcResult = { data: null, error: { code: "57014", message: "timeout" } };
  await assert.rejects(claimScheduledOlxJob("cloudflare-olx-scheduled"), /OLX_JOB_CLAIM_FAILED/);
  assert.throws(() => parseScheduledClaim({ job: null, reason: "SOMETHING" }), /OLX_SCHEDULED_CLAIM_INVALID/);
  assert.throws(() => parseScheduledClaim({ job: { ...job, requested_by: null }, reason: null }), /OLX_SCHEDULED_CLAIM_MISMATCH/);
  assert.throws(() => parseScheduledClaim({ job: { ...job, context_type: "price_radar" }, reason: null }), /OLX_SCHEDULED_CLAIM_MISMATCH/);
  assert.throws(() => parseScheduledClaim({ job: { ...job, request_url: "https://evil.example/" }, reason: null }));
  assert.throws(() => parseScheduledClaim("x"), /OLX_SCHEDULED_CLAIM_INVALID/);
  assert.throws(() => parseScheduledClaim([job]), /OLX_SCHEDULED_CLAIM_INVALID/);
  await assert.rejects(claimScheduledOlxJob("ab"), /INVALID_WORKER_ID/);
});

test("expiry: counts on success, null (no change) before the migration, never throws", async () => {
  const client = (result: unknown) => ({ rpc: () => ({ abortSignal: async () => result }) }) as never;
  assert.deepEqual(await expireStaleScheduledOlxJobs(client({ data: { unclaimed_expired: 1, lease_expired: 0 }, error: null })), { unclaimedExpired: 1, leaseExpired: 0 });
  assert.equal(await expireStaleScheduledOlxJobs(client({ data: null, error: { code: "PGRST202", message: "missing" } })), null);
  const warn = mock.method(console, "warn", () => undefined);
  try {
    assert.equal(await expireStaleScheduledOlxJobs(client({ data: null, error: { code: "XX000", message: "boom" } })), null);
    assert.equal(warn.mock.calls[0].arguments[0], "FINDER_OLX_EXPIRE_FAILED");
  } finally { warn.mock.restore(); }
});

test("monitoring: switch state and the last automatic jobs; unavailable before the migration", async () => {
  const fake = (control: unknown, jobs: unknown[]) => ({
    from(table: string) {
      const builder = {
        select() { return builder; }, eq() { return builder; }, order() { return builder; },
        limit: async () => ({ data: jobs, error: null }),
        maybeSingle: async () => table === "olx_automation_control" ? control : { data: null, error: null },
      };
      return builder;
    },
  }) as never;
  const status = await getOlxAutomationStatus(fake({ data: { scheduled_claim_enabled: false, max_claims_24h: 1, unclaimed_expiry_minutes: 360, note: "STOP", updated_at: "2026-10-15T00:00:00Z" }, error: null }, [
    { id: "j1", status: "failed", created_at: "2026-10-15T07:30:00Z", started_at: null, finished_at: "2026-10-15T13:30:00Z", worker_id: null, error_code: "OLX_SCHEDULED_JOB_NOT_CLAIMED", attempts: 0 },
    { id: "j0", status: "queued", created_at: "2026-10-14T07:30:00Z", started_at: null, finished_at: null, worker_id: null, error_code: null, attempts: 0 },
  ]));
  assert.equal(status.available, true);
  assert.equal(status.enabled, false);
  assert.equal(status.recentJobs[0].errorCode, "OLX_SCHEDULED_JOB_NOT_CLAIMED");
  assert.equal(status.waiting, 1);
  const missing = await getOlxAutomationStatus(fake({ data: null, error: { code: "42P01", message: "relation does not exist" } }, []));
  assert.equal(missing.available, false);
  assert.equal(missing.enabled, null);
});
