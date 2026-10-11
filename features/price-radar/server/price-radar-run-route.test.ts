import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Run = { id: string; status: string; leaseToken: string | null; leaseUntil: string | null; stopRequestedAt?: string | null; userTerminatedAt?: string | null; errorMessage?: string | null };
let latest: Run | null = null;
let operatorError: Error | null = null;
let resumeResult: { kind: "claimed"; run: Run } | { kind: "blocked"; reason: string } = { kind: "blocked", reason: "run_changed" };
let resumeCalls: string[] = [];
let stopCalls: Array<{ ownerId: string; runId: string }> = [];
let stopResult: { kind: "stopping" | "stopped" } | { kind: "blocked"; reason: string } = { kind: "stopping" };
let stopError: Error | null = null;
let terminationCalls: Array<{ ownerId: string; runId: string }> = [];
let terminationResult: { kind: "terminated" } | { kind: "blocked"; reason: string } = { kind: "terminated" };
let terminationError: Error | null = null;
let claimCalls: string[] = [];
let claimCriteria: unknown[] = [];
let portionCalls: Array<{ runId: string; ownerId: string; leaseToken: string }> = [];

mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (operatorError) throw operatorError; return { id: "owner-1" }; },
  operatorAuthorizationResponse: () => Response.json({ message: "unauthorized" }, { status: 401 }),
} });
mock.module("@/features/price-radar/server/collect", { namedExports: {
  claimOrCreateRadarRun: async (ownerId: string, sources: unknown, _client: unknown, criteria: unknown) => { claimCalls.push(ownerId); claimCriteria = [sources, criteria]; return { kind: "claimed", run: { id: "new-run", leaseToken: "new-token" } }; },
  resumeExistingRadarRun: async (_ownerId: string, runId: string) => { resumeCalls.push(runId); return resumeResult; },
  requestRadarRunStop: async (ownerId: string, runId: string) => { stopCalls.push({ ownerId, runId }); if (stopError) throw stopError; return stopResult; },
  requestRadarRunTermination: async (ownerId: string, runId: string) => { terminationCalls.push({ ownerId, runId }); if (terminationError) throw terminationError; return terminationResult; },
  runRadarCollectionPortion: async (input: { runId: string; ownerId: string; leaseToken: string }) => { portionCalls.push(input); return { status: "running", scannedCount: 12, qualifiedCount: 2, sourceStatuses: {}, sourceErrors: {}, qualificationRejections: {} }; },
} });
let sourcesFilteredToEmpty = false;
mock.module("@/features/price-radar/server/radar-settings", { namedExports: {
  readRadarSettings: async () => ({ sources: ["morizon"], areaMin: 31, areaMax: 62, rooms: [1, 2, 3], minPricePerSqm: 8_800 }),
  radarSettingsSourcesWereFilteredToEmpty: async () => sourcesFilteredToEmpty,
} });
mock.module("@/features/price-radar/server/radar-run-status", { namedExports: { latestRadarRun: async () => latest } });

const route = await import("../../../app/api/price-radar/run/route.ts");

function reset() {
  latest = { id: "existing-run", status: "running", leaseToken: null, leaseUntil: "2026-10-10T10:00:00.000Z", stopRequestedAt: null, errorMessage: null };
  operatorError = null;
  resumeResult = { kind: "claimed", run: { id: "existing-run", status: "running", leaseToken: "fresh-token", leaseUntil: "2026-10-10T10:02:00.000Z" } };
  resumeCalls = [];
  stopCalls = [];
  stopResult = { kind: "stopping" };
  stopError = null;
  terminationCalls = [];
  terminationResult = { kind: "terminated" };
  terminationError = null;
  claimCalls = [];
  claimCriteria = [];
  portionCalls = [];
  sourcesFilteredToEmpty = false;
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

test("only an authenticated operator can request a stop for one exact run; stopping never starts a collection portion", async () => {
  reset();
  operatorError = new Error("unauthorized");
  const anonymous = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop", runId: "existing-run" }) }));
  assert.equal(anonymous.status, 401);
  assert.deepEqual(stopCalls, []);
  assert.deepEqual(portionCalls, []);

  reset();
  const stopping = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop", runId: "existing-run" }) }));
  assert.equal(stopping.status, 200);
  assert.deepEqual(await stopping.json(), { runId: "existing-run", status: "stopping" });
  assert.deepEqual(stopCalls, [{ ownerId: "owner-1", runId: "existing-run" }]);
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("a repeated stop is idempotent after the SQL layer confirms the run stopped", async () => {
  reset();
  stopResult = { kind: "stopped" };
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "stop", runId: "existing-run" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { runId: "existing-run", status: "stopped" });
  assert.deepEqual(portionCalls, [], "a stop request never runs or resumes the collection portion");
});

test("only the authenticated owner can persist an idempotent terminal end for the exact run", async () => {
  reset();
  operatorError = new Error("unauthorized");
  const anonymous = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "terminate", runId: "existing-run" }) }));
  assert.equal(anonymous.status, 401);
  assert.deepEqual(terminationCalls, []);
  assert.deepEqual(portionCalls, []);

  reset();
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "terminate", runId: "existing-run" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { runId: "existing-run", status: "terminated" });
  assert.deepEqual(terminationCalls, [{ ownerId: "owner-1", runId: "existing-run" }]);
  assert.deepEqual(stopCalls, [], "terminal end is distinct from resumable STOP");
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, [], "ending a run never starts or resumes a collection portion");
});

test("termination write failures and terminal run resumes are surfaced without changing or resuming the run", async () => {
  reset();
  terminationError = new Error("RADAR_RUN_TERMINATION_FAILED");
  const failedWrite = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "terminate", runId: "existing-run" }) }));
  assert.equal(failedWrite.status, 500);
  assert.deepEqual(await failedWrite.json(), { code: "RADAR_RUN_TERMINATION_FAILED", message: "Nie udało się trwale zapisać zakończenia przebiegu Radaru." });
  assert.deepEqual(portionCalls, []);

  reset();
  latest = { ...latest!, status: "partial", userTerminatedAt: "2026-10-11T18:00:00.000Z", errorMessage: null };
  const resume = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }) }));
  assert.equal(resume.status, 409);
  assert.equal((await resume.json()).code, "RADAR_RUN_CHANGED");
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("a stop persistence failure is returned as an explicit server error, never as a successful stopping response", async () => {
  reset();
  stopError = new Error("RADAR_RUN_STOP_FAILED");
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "stop", runId: "existing-run" }),
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    code: "RADAR_RUN_STOP_FAILED",
    message: "Nie udało się zapisać żądania zatrzymania Radaru.",
  });
  assert.deepEqual(portionCalls, [], "a failed STOP write never resumes or starts collection work");
});

test("a stopped checkpoint is resumed only by an authenticated operator request for that same run ID", async () => {
  reset();
  latest = { id: "existing-run", status: "partial", leaseToken: null, leaseUntil: null, stopRequestedAt: "2026-10-11T13:00:00.000Z", errorMessage: "RADAR_STOPPED_BY_OPERATOR" };
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(resumeCalls, ["existing-run"]);
  assert.deepEqual(portionCalls, [{ runId: "existing-run", ownerId: "owner-1", leaseToken: "fresh-token" }]);
  assert.deepEqual(claimCalls, [], "resuming after STOP must never claim/create another run");
});

test("auto-resume is bound to a live, nonterminal expected run ID and processes that ID only", async () => {
  reset();
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(resumeCalls, ["existing-run"]);
  assert.deepEqual(claimCalls, [], "the resume-only path never calls claim-or-create");
  assert.deepEqual(portionCalls, [{ runId: "existing-run", ownerId: "owner-1", leaseToken: "fresh-token" }]);
});

test("a pending STOP request cannot be cancelled by an automatic or manual resume request", async () => {
  reset();
  latest = { ...latest!, stopRequestedAt: "2026-10-10T10:00:00.000Z" };
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRunId: "existing-run" }),
  }));
  assert.equal(response.status, 409);
  assert.deepEqual(resumeCalls, [], "the explicit stop request is not cleared before the worker acknowledges it");
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, []);
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
  assert.deepEqual(claimCriteria, [["morizon"], { areaMin: 31, areaMax: 62, rooms: [1, 2, 3], minPricePerSqm: 8_800, qualityRulesVersion: 2 }], "a new run freezes saved bounds, the unit-price filter, and the current qualification rules version");
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, [{ runId: "new-run", ownerId: "owner-1", leaseToken: "new-token" }]);
});

test("a saved selection filtered to empty by a disabled source (e.g. szybko) is refused with a readable message -- it never silently starts scanning every active source", async () => {
  reset();
  sourcesFilteredToEmpty = true;
  const response = await route.POST(new Request("http://localhost/api/price-radar/run", { method: "POST" }));
  assert.equal(response.status, 400);
  const body = await response.json() as { message?: string };
  assert.match(body.message ?? "", /wyłączone/i);
  assert.deepEqual(claimCalls, [], "claim-or-create must never run -- that is the exact path that would reinterpret an empty list as 'all sources'");
  assert.deepEqual(portionCalls, []);
});
