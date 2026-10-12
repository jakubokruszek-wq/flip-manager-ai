import assert from "node:assert/strict";
import test, { mock } from "node:test";

let operatorError: Error | null = null;
let queueReadResult: unknown = { available: true, pending: [], confirmed: [], rejected: [] };
let resolveResult: unknown = { ok: true, listingId: "listing-1" };
let rejectResult: unknown = { ok: true };
let settings: { minPricePerSqm: number | null; districts: string[] } = { minPricePerSqm: 8_800, districts: ["Górna", "Widzew"] };
const resolveCalls: Array<{ ownerId: string; queueId: string; decision: unknown; minPricePerSqm: unknown; districts: unknown }> = [];
const rejectCalls: Array<{ ownerId: string; queueId: string; rejected: boolean }> = [];
const settingsReadsFor: string[] = [];

mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (operatorError) throw operatorError; return { id: "owner-1" }; },
  operatorAuthorizationResponse: () => Response.json({ message: "unauthorized" }, { status: 401 }),
} });
mock.module("@/features/price-radar/server/radar-verification-queue", { namedExports: {
  getRadarVerificationQueue: async () => queueReadResult,
  resolveRadarVerificationCandidate: async (ownerId: string, queueId: string, decision: unknown, _supabase: unknown, minPricePerSqm: unknown, districts: unknown) => {
    resolveCalls.push({ ownerId, queueId, decision, minPricePerSqm, districts });
    return resolveResult;
  },
  setRadarVerificationQueueRejection: async (ownerId: string, queueId: string, rejected: boolean) => { rejectCalls.push({ ownerId, queueId, rejected }); return rejectResult; },
} });
mock.module("@/features/price-radar/server/radar-settings", { namedExports: {
  readRadarSettings: async (ownerId: string) => { settingsReadsFor.push(ownerId); return settings; },
} });

const readRoute = await import("../../../app/api/price-radar/verification-queue/route.ts");
const resolveRoute = await import("../../../app/api/price-radar/verification-queue/resolve/route.ts");
const rejectRoute = await import("../../../app/api/price-radar/verification-queue/reject/route.ts");

function reset() {
  operatorError = null;
  queueReadResult = { available: true, pending: [], confirmed: [], rejected: [] };
  resolveResult = { ok: true, listingId: "listing-1" };
  rejectResult = { ok: true };
  settings = { minPricePerSqm: 8_800, districts: ["Górna", "Widzew"] };
  resolveCalls.length = 0;
  rejectCalls.length = 0;
  settingsReadsFor.length = 0;
}

function validDecision(overrides: Record<string, unknown> = {}) {
  return {
    apartmentSaleConfirmed: true, price: 450_000, area: 50, rooms: 2, city: "Łódź",
    district: "Górna", buildingType: "blok", marketType: "secondary", qualityCategory: "fresh_renovation",
    ...overrides,
  };
}

function postResolve(body: unknown) {
  return resolveRoute.POST(new Request("http://localhost/api/price-radar/verification-queue/resolve", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

test("GET requires an authenticated operator session", async () => {
  reset();
  operatorError = new Error("unauthorized");
  const response = await readRoute.GET();
  assert.equal(response.status, 401);
});

test("GET returns the owner-scoped queue read verbatim", async () => {
  reset();
  queueReadResult = { available: true, pending: [{ id: "q-1" }], confirmed: [], rejected: [] };
  const response = await readRoute.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), queueReadResult);
});

test("resolve requires a queueId and a complete, valid decision before calling the server function", async () => {
  reset();
  const missingQueueId = await postResolve({ decision: validDecision() });
  assert.equal(missingQueueId.status, 400);
  const missingDecision = await postResolve({ queueId: "q-1" });
  assert.equal(missingDecision.status, 400);
  assert.deepEqual(resolveCalls, [], "an incomplete request must never reach the server-side re-qualification");
});

test("resolve rejects a decision missing the explicit operator sale confirmation, even with every other field present", async () => {
  reset();
  const response = await postResolve({ queueId: "q-1", decision: validDecision({ apartmentSaleConfirmed: false }) });
  assert.equal(response.status, 400);
  assert.deepEqual(resolveCalls, []);
});

test("resolve rejects a city other than Łódź, a district outside the 5 known ones, an invalid building/market/standard, and a non-positive price/area/rooms -- the source payload cannot smuggle an invalid decision past validation", async () => {
  reset();
  const invalidCases = [
    validDecision({ city: "Warszawa" }),
    validDecision({ district: "Nibylandia" }),
    validDecision({ buildingType: "kamienica" }),
    validDecision({ marketType: "unknown" }),
    validDecision({ qualityCategory: "unknown" }),
    validDecision({ price: 0 }),
    validDecision({ area: -5 }),
    validDecision({ rooms: 1.5 }),
  ];
  for (const decision of invalidCases) {
    const response = await postResolve({ queueId: "q-1", decision });
    assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(decision)}`);
  }
  assert.deepEqual(resolveCalls, [], "no invalid decision ever reaches the server-side re-qualification");
});

test("resolve ignores any extra/unexpected fields on the decision payload -- only the explicit, validated fields are forwarded", async () => {
  reset();
  const response = await postResolve({ queueId: "q-1", decision: validDecision({ injectedField: "ignored", operatorDecisionOverride: true, confirmed: true }) });
  assert.equal(response.status, 200);
  assert.deepEqual(resolveCalls[0]?.decision, validDecision());
});

test("resolve passes the session-derived owner id, never a client-supplied one", async () => {
  reset();
  const response = await postResolve({ queueId: "q-1", decision: validDecision(), ownerId: "attacker-supplied" });
  assert.equal(response.status, 200);
  assert.equal(resolveCalls[0]?.ownerId, "owner-1");
});

test("resolve re-reads the operator's CURRENT saved min price/m2 and selected districts and forwards them to re-qualification -- never a stale or client-supplied value", async () => {
  reset();
  settings = { minPricePerSqm: 9_500, districts: ["Bałuty"] };
  await postResolve({ queueId: "q-1", decision: validDecision(), minPricePerSqm: 1, districts: ["Widzew"] });
  assert.deepEqual(settingsReadsFor, ["owner-1"]);
  assert.equal(resolveCalls[0]?.minPricePerSqm, 9_500, "the server's own saved threshold must be used, not anything the client sent");
  assert.deepEqual(resolveCalls[0]?.districts, ["Bałuty"], "the server's own saved district selection must be used, not anything the client sent");
});

test("resolve maps each failure reason to a distinct, honest status code -- a save error never looks like success", async () => {
  reset();
  const cases: Array<[unknown, number]> = [
    [{ ok: false, reason: "schema_unavailable" }, 503],
    [{ ok: false, reason: "not_found" }, 404],
    [{ ok: false, reason: "no_longer_qualifies", detail: "price_per_sqm_below_minimum" }, 409],
    [{ ok: false, reason: "invalid_decision" }, 400],
  ];
  for (const [result, status] of cases) {
    resolveResult = result;
    const response = await postResolve({ queueId: "q-1", decision: validDecision() });
    assert.equal(response.status, status, `expected ${status} for ${JSON.stringify(result)}`);
  }
});

test("a confirmed offer no longer meeting the operator's current price/m2 or district scope is reported as no_longer_qualifies, not silently approved", async () => {
  reset();
  resolveResult = { ok: false, reason: "no_longer_qualifies", detail: "district_not_in_selected_scope" };
  const response = await postResolve({ queueId: "q-1", decision: validDecision() });
  assert.equal(response.status, 409);
  const body = await response.json() as { reason?: string };
  assert.equal(body.reason, "district_not_in_selected_scope");
});

test("reject requires queueId and defaults to rejecting (not undoing)", async () => {
  reset();
  const missing = await rejectRoute.POST(new Request("http://localhost/api/price-radar/verification-queue/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
  assert.equal(missing.status, 400);
  const response = await rejectRoute.POST(new Request("http://localhost/api/price-radar/verification-queue/reject", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(rejectCalls, [{ ownerId: "owner-1", queueId: "q-1", rejected: true }]);
});

test("reject with rejected:false undoes a rejection, scoped to the session owner", async () => {
  reset();
  const response = await rejectRoute.POST(new Request("http://localhost/api/price-radar/verification-queue/reject", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: "q-1", rejected: false, ownerId: "attacker-supplied" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(rejectCalls, [{ ownerId: "owner-1", queueId: "q-1", rejected: false }]);
});
