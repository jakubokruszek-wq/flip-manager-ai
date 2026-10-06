import assert from "node:assert/strict";
import test, { mock } from "node:test";

let authorized = false;
let calls: string[] = [];
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (!authorized) throw new Error("Unauthorized"); },
  operatorAuthorizationResponse: () => Response.json({ error: "Unauthorized" }, { status: 401 }),
} });
mock.module("@/features/flip-finder/server/manual-scan", { namedExports: {
  runFinderScanPortion: async (runId: string) => { calls.push(runId); return { runId, status: "completed", claimed: 0 }; },
} });
const route = await import("../../../app/api/flip-finder/scans/[runId]/continue/route.ts");

test("anonymous continuation fails before parameters or worker access", async () => {
  authorized = false; calls = [];
  const response = await route.POST(new Request("http://localhost/api/flip-finder/scans/run/continue", { method: "POST" }), { params: new Promise(() => undefined) });
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("operator continuation passes the exact run ID and awaits its bounded portion", async () => {
  authorized = true; calls = [];
  const runId = "10000000-0000-4000-8000-000000000001";
  const response = await route.POST(new Request(`http://localhost/api/flip-finder/scans/${runId}/continue`, { method: "POST" }), { params: Promise.resolve({ runId }) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [runId]);
  assert.equal((await response.json()).runId, runId);
  assert.equal(route.maxDuration, 60);
});
