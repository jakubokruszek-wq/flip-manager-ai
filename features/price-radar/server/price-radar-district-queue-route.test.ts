import assert from "node:assert/strict";
import test, { mock } from "node:test";

let operatorError: Error | null = null;
let queueReadResult: unknown = { available: true, pending: [], assigned: [], rejected: [] };
let assignResult: unknown = { ok: true, listingId: "listing-1" };
let rejectResult: unknown = { ok: true };
const assignCalls: Array<{ ownerId: string; queueId: string; district: string }> = [];
const rejectCalls: Array<{ ownerId: string; queueId: string; rejected: boolean }> = [];

mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (operatorError) throw operatorError; return { id: "owner-1" }; },
  operatorAuthorizationResponse: () => Response.json({ message: "unauthorized" }, { status: 401 }),
} });
mock.module("@/features/price-radar/server/radar-district-queue", { namedExports: {
  getRadarDistrictQueue: async () => queueReadResult,
  assignRadarDistrictQueueCandidate: async (ownerId: string, queueId: string, district: string) => { assignCalls.push({ ownerId, queueId, district }); return assignResult; },
  setRadarDistrictQueueRejection: async (ownerId: string, queueId: string, rejected: boolean) => { rejectCalls.push({ ownerId, queueId, rejected }); return rejectResult; },
} });
// The assign route also reads the operator's saved minPricePerSqm to pass
// into qualification. Mocked here rather than left real: the real settings
// module imports RADAR_SOURCES from collect.ts, which imports the REAL
// radar-district-queue module (including radarDistrictQueueFailureWarning,
// not part of the partial mock above) -- loading it for real here would
// crash on that missing export despite this test never exercising it.
mock.module("@/features/price-radar/server/radar-settings", { namedExports: {
  readRadarSettings: async () => ({ districts: [], market: "both", areaMin: null, areaMax: null, rooms: [], sources: [], minPricePerSqm: null }),
} });

const readRoute = await import("../../../app/api/price-radar/district-queue/route.ts");
const assignRoute = await import("../../../app/api/price-radar/district-queue/assign/route.ts");
const rejectRoute = await import("../../../app/api/price-radar/district-queue/reject/route.ts");

function reset() {
  operatorError = null;
  queueReadResult = { available: true, pending: [], assigned: [], rejected: [] };
  assignResult = { ok: true, listingId: "listing-1" };
  rejectResult = { ok: true };
  assignCalls.length = 0;
  rejectCalls.length = 0;
}

test("GET requires an authenticated operator session", async () => {
  reset();
  operatorError = new Error("unauthorized");
  const response = await readRoute.GET();
  assert.equal(response.status, 401);
});

test("GET returns the owner-scoped queue read verbatim", async () => {
  reset();
  queueReadResult = { available: true, pending: [{ id: "q-1" }], assigned: [], rejected: [] };
  const response = await readRoute.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, queueReadResult);
});

test("assign requires queueId and district before calling the server function", async () => {
  reset();
  const response = await assignRoute.POST(new Request("http://localhost/api/price-radar/district-queue/assign", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(assignCalls, []);
});

test("assign passes the session-derived owner id, never a client-supplied one", async () => {
  reset();
  const response = await assignRoute.POST(new Request("http://localhost/api/price-radar/district-queue/assign", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ queueId: "q-1", district: "Bałuty", ownerId: "attacker-supplied" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(assignCalls, [{ ownerId: "owner-1", queueId: "q-1", district: "Bałuty" }]);
});

test("assign maps each failure reason to a distinct, honest status code -- a save error never looks like success", async () => {
  reset();
  const cases: Array<[unknown, number]> = [
    [{ ok: false, reason: "schema_unavailable" }, 503],
    [{ ok: false, reason: "not_found" }, 404],
    [{ ok: false, reason: "invalid_district" }, 400],
    [{ ok: false, reason: "no_longer_qualifies", detail: "building_type_not_confirmed" }, 409],
  ];
  for (const [result, status] of cases) {
    assignResult = result;
    const response = await assignRoute.POST(new Request("http://localhost/api/price-radar/district-queue/assign", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1", district: "Bałuty" }),
    }));
    assert.equal(response.status, status, `expected ${status} for ${JSON.stringify(result)}`);
  }
});

test("reject requires queueId and defaults to rejecting (not undoing)", async () => {
  reset();
  const missing = await rejectRoute.POST(new Request("http://localhost/api/price-radar/district-queue/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
  assert.equal(missing.status, 400);

  const response = await rejectRoute.POST(new Request("http://localhost/api/price-radar/district-queue/reject", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(rejectCalls, [{ ownerId: "owner-1", queueId: "q-1", rejected: true }]);
});

test("reject with rejected:false undoes a rejection, scoped to the session owner", async () => {
  reset();
  const response = await rejectRoute.POST(new Request("http://localhost/api/price-radar/district-queue/reject", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1", rejected: false, ownerId: "attacker-supplied" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(rejectCalls, [{ ownerId: "owner-1", queueId: "q-1", rejected: false }]);
});

test("reject reports schema_unavailable distinctly from not_found", async () => {
  reset();
  rejectResult = { ok: false, reason: "schema_unavailable" };
  const unavailable = await rejectRoute.POST(new Request("http://localhost/api/price-radar/district-queue/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1" }) }));
  assert.equal(unavailable.status, 503);

  rejectResult = { ok: false, reason: "not_found" };
  const notFound = await rejectRoute.POST(new Request("http://localhost/api/price-radar/district-queue/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1" }) }));
  assert.equal(notFound.status, 404);
});
