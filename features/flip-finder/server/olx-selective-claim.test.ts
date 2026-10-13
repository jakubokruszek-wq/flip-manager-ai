import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: { code?: string; message: string } | null } = { data: [], error: null };

mock.module("@/features/flip-finder/server/olx-worker-admin", {
  namedExports: {
    createOlxWorkerAdminClient: () => ({
      rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return rpcResult; },
    }),
  },
});

const { claimSelectedOlxJob, parseClaimSelector } = await import("./olx-selective-claim.ts");

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = {
  id: JOB, scan_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", source_scan_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", search_filter_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  context_type: "finder", request_url: "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/", lease_token: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", leased_until: "2026-10-13T12:00:00Z", attempts: 1,
};

test("payload: only { workerId, jobId } with a UUID job id; no filter, no 'oldest job'", () => {
  assert.deepEqual(parseClaimSelector({ workerId: "cloudflare-olx-stage2", jobId: JOB }), { workerId: "cloudflare-olx-stage2", jobId: JOB });
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-stage2" }), /INVALID_JOB_ID/, "no selector would mean 'any job'");
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-stage2", filterId: JOB }), /INVALID_SELECTOR/);
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-stage2", jobId: JOB, filterId: JOB }), /INVALID_SELECTOR/);
  assert.throws(() => parseClaimSelector({ workerId: "cloudflare-olx-stage2", jobId: "1; drop table olx_scan_jobs" }), /INVALID_JOB_ID/);
  assert.throws(() => parseClaimSelector({ jobId: JOB }), /INVALID_PAYLOAD/);
  assert.throws(() => parseClaimSelector([JOB]), /INVALID_PAYLOAD/);
  assert.throws(() => parseClaimSelector(null), /INVALID_PAYLOAD/);
});

test("claim calls only claim_olx_scan_job_selective with the job id and maps the row", async () => {
  calls.length = 0;
  rpcResult = { data: [row], error: null };
  const job = await claimSelectedOlxJob("cloudflare-olx-stage2", JOB);
  assert.deepEqual(calls, [{ fn: "claim_olx_scan_job_selective", args: { p_worker_id: "cloudflare-olx-stage2", p_job_id: JOB, p_lease_seconds: 120 } }]);
  assert.equal(job?.id, JOB);
  assert.equal(job?.contextType, "finder");
  assert.equal(job?.radarRunLeaseToken, null);
  assert.equal(job?.leaseToken, row.lease_token);
});

test("nothing claimable → null; missing migration fails closed; a non-matching row is rejected", async () => {
  rpcResult = { data: [], error: null };
  assert.equal(await claimSelectedOlxJob("cloudflare-olx-stage2", JOB), null);
  rpcResult = { data: null, error: { code: "PGRST202", message: "Could not find the function public.claim_olx_scan_job_selective" } };
  await assert.rejects(claimSelectedOlxJob("cloudflare-olx-stage2", JOB), /OLX_SELECTIVE_CLAIM_UNAVAILABLE/);
  rpcResult = { data: [{ ...row, context_type: "price_radar" }], error: null };
  await assert.rejects(claimSelectedOlxJob("cloudflare-olx-stage2", JOB), /OLX_SELECTIVE_CLAIM_MISMATCH/);
  rpcResult = { data: [{ ...row, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }], error: null };
  await assert.rejects(claimSelectedOlxJob("cloudflare-olx-stage2", JOB), /OLX_SELECTIVE_CLAIM_MISMATCH/);
  rpcResult = { data: [{ ...row, request_url: "https://evil.example/" }], error: null };
  await assert.rejects(claimSelectedOlxJob("cloudflare-olx-stage2", JOB), /OLX_URL_NOT_ALLOWED/);
  await assert.rejects(claimSelectedOlxJob("cloudflare-olx-stage2", "not-a-uuid"), /INVALID_JOB_ID/);
});
