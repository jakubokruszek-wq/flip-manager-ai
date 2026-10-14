import assert from "node:assert/strict";
import test, { mock } from "node:test";

/** OLX schedule diagnostics: operator only, read-only (dry run), never a way to queue or retry OLX. */
let authorized = true;
let filter: Record<string, unknown> | null = null;
const rpcCalls: Array<Record<string, unknown>> = [];
mock.module("server-only", { defaultExport: {} });
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (!authorized) throw new Error("unauthorized"); return { id: "operator", email: null }; },
  operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }),
} });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => filter } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => ({
  rpc: (_name: string, args: Record<string, unknown>) => {
    rpcCalls.push(args);
    return { abortSignal: async () => ({ data: { decision: "skipped", reason: "OLX_INTERVAL_NOT_ELAPSED", last_job_at: "2026-10-13T07:30:00+00:00", next_allowed_at: "2026-10-14T07:30:00+00:00", automatic_jobs_in_window: 1, total_jobs_in_window: 1, shared_limit: 1 }, error: null }) };
  },
}) } });

const { GET } = await import("./route.ts");
const params = { params: Promise.resolve({ id: "filter-1" }) };
const flip = { id: "filter-1", name: "Flip", sources: ["otodom", "olx"], city: "Łódź", isActive: true, finderOlxScanIntervalMinutes: 1440 };

test("unauthenticated requests get 401 and never reach the database", async () => {
  authorized = false; rpcCalls.length = 0;
  const response = await GET(new Request("http://localhost"), params);
  assert.equal(response.status, 401);
  assert.equal(rpcCalls.length, 0);
  authorized = true;
});

test("unknown filter is 404", async () => {
  filter = null;
  assert.equal((await GET(new Request("http://localhost"), params)).status, 404);
});

test("reports last order, next allowed time, reason and budget through a dry run only", async () => {
  filter = flip; rpcCalls.length = 0;
  const response = await GET(new Request("http://localhost"), params);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.reason, "OLX_INTERVAL_NOT_ELAPSED");
  assert.equal(body.nextAllowedAt, "2026-10-14T07:30:00+00:00");
  assert.equal(body.budget.totalJobs, 1);
  assert.equal(body.olxSelected, true);
  assert.equal(body.cloudflareBrowserSeconds, null, "browser seconds are not reliably available in the app");
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].p_dry_run, true, "diagnostics never queue a job");
});
