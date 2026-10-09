import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Run = { id: string; status: string; leaseToken: string | null; leaseUntil: string | null };
let latest: Run | null = null;
let operatorError: Error | null = null;
let resumeResult: { kind: "claimed"; run: Run } | { kind: "blocked"; reason: string } = { kind: "blocked", reason: "run_changed" };
let resumeCalls: string[] = [];
let claimCalls: string[] = [];
let portionCalls: Array<{ runId: string; ownerId: string; leaseToken: string }> = [];

mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (operatorError) throw operatorError; return { id: "owner-1" }; },
  operatorAuthorizationResponse: () => Response.json({ message: "unauthorized" }, { status: 401 }),
} });
mock.module("@/features/price-radar/server/collect", { namedExports: {
  claimOrCreateRadarRun: async (ownerId: string) => { claimCalls.push(ownerId); return { kind: "claimed", run: { id: "new-run", leaseToken: "new-token" } }; },
  resumeExistingRadarRun: async (_ownerId: string, runId: string) => { resumeCalls.push(runId); return resumeResult; },
  runRadarCollectionPortion: async (input: { runId: string; ownerId: string; leaseToken: string }) => { portionCalls.push(input); return { status: "running", scannedCount: 12, qualifiedCount: 2, sourceStatuses: {}, sourceErrors: {} }; },
} });
mock.module("@/features/price-radar/server/radar-settings", { namedExports: { readRadarSettings: async () => ({ sources: ["morizon"] }) } });
mock.module("@/features/price-radar/server/radar-run-status", { namedExports: { latestRadarRun: async () => latest } });

const route = await import("../../../app/api/price-radar/run/route.ts");

function reset() {
  latest = { id: "existing-run", status: "running", leaseToken: null, leaseUntil: "2026-10-10T10:00:00.000Z" };
  operatorError = null;
  resumeResult = { kind: "claimed", run: { id: "existing-run", status: "running", leaseToken: "fresh-token", leaseUntil: "2026-10-10T10:02:00.000Z" } };
  resumeCalls = [];
  claimCalls = [];
  portionCalls = [];
}

test("anonymous auto-resume does not claim or process a Radar run", async () => {
  reset();
  operatorError = new Error("unauthorized");
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }) }));
  assert.equal(response.status, 401);
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("auto-resume is bound to a live, nonterminal expected run ID and processes that ID only", async () => {
  reset();
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(resumeCalls, ["existing-run"]);
  assert.deepEqual(claimCalls, [], "the resume-only path never calls claim-or-create");
  assert.deepEqual(portionCalls, [{ runId: "existing-run", ownerId: "owner-1", leaseToken: "fresh-token" }]);
});

test("changed/terminal run IDs and OLX-owned work are refused without starting another run", async () => {
  reset();
  latest = { ...latest!, id: "different-run" };
  const changed = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }) }));
  assert.equal(changed.status, 409);
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(claimCalls, []);

  reset();
  resumeResult = { kind: "blocked", reason: "olx_queue_owns_source" };
  const olx = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }) }));
  assert.equal(olx.status, 409);
  assert.equal((await olx.json()).code, "olx_queue_owns_source");
  assert.deepEqual(portionCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("manual start without expectedRunId retains the existing claim-or-create path", async () => {
  reset();
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST" }));
  assert.equal(response.status, 200);
  assert.deepEqual(claimCalls, ["owner-1"]);
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, [{ runId: "new-run", ownerId: "owner-1", leaseToken: "new-token" }]);
});
