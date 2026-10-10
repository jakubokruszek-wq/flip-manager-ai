import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

let ownerRows: Row[] = [];
let adminCalls: Array<{ op: string; table: string; payload?: Row; filters: Row }> = [];
let settingsCalls: string[] = [];
let claimCalls: string[] = [];
let claimCriteria: Array<{ ownerId: string; sources: unknown; criteria: unknown }> = [];
let claimResults: Record<string, { kind: "claimed"; run: { id: string; leaseToken: string } } | { kind: "blocked" }> = {};
let portionCalls: Array<{ runId: string; ownerId: string; leaseToken: string }> = [];

function fakeAdmin() {
  return {
    from(table: string) {
      const filters: Row = {};
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: async () => {
          adminCalls.push({ op: "select", table, filters: { ...filters } });
          return { data: table === "price_radar_settings" ? ownerRows : [], error: null };
        },
        update: (payload: Row) => {
          adminCalls.push({ op: "update", table, payload, filters: { ...filters } });
          return { eq: async () => ({ data: null, error: null }) };
        },
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
      };
      return builder;
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: {
  createAdminClient: () => fakeAdmin(),
} });
mock.module("@/features/price-radar/server/radar-settings", { namedExports: {
  readRadarSettings: async (ownerId: string) => { settingsCalls.push(ownerId); return { districts: [], market: "both", areaMin: 31, areaMax: 62, rooms: [1, 2, 3], sources: ["oferty_net"], minPricePerSqm: 8_800 }; },
} });
mock.module("@/features/price-radar/server/collect", { namedExports: {
  claimOrCreateRadarRun: async (ownerId: string, sources: unknown, _client: unknown, criteria: unknown) => { claimCalls.push(ownerId); claimCriteria.push({ ownerId, sources, criteria }); return claimResults[ownerId] ?? { kind: "blocked" }; },
  runRadarCollectionPortion: async (input: { runId: string; ownerId: string; leaseToken: string }) => { portionCalls.push(input); return { status: "completed", scannedCount: 3, qualifiedCount: 1, sourceStatuses: {}, sourceErrors: {}, qualificationRejections: {} }; },
} });

const route = await import("../../../app/api/jobs/price-radar-collect/route.ts");

function reset() {
  ownerRows = [];
  adminCalls = [];
  settingsCalls = [];
  claimCalls = [];
  claimCriteria = [];
  claimResults = {};
  portionCalls = [];
}

function withCronSecret<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = value;
  return run().finally(() => { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; });
}

test("missing CRON_SECRET server configuration rejects the request before any Radar work starts", async () => {
  reset();
  await withCronSecret(undefined, async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST" }));
    assert.equal(response.status, 503);
  });
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("a request with no Authorization header is rejected before any Radar work starts", async () => {
  reset();
  await withCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST" }));
    assert.equal(response.status, 401);
  });
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("an incorrect secret is rejected before any Radar work starts", async () => {
  reset();
  await withCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer wrong-secret" } }));
    assert.equal(response.status, 401);
  });
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("the correct secret as a bare Vercel Cron Authorization: Bearer header runs the job with no browser session, via both GET and POST", async () => {
  for (const method of ["GET", "POST"] as const) {
    reset();
    ownerRows = [{ owner_id: "owner-a" }];
    claimResults = { "owner-a": { kind: "claimed", run: { id: "run-1", leaseToken: "lease-1" } } };
    await withCronSecret("test-secret", async () => {
      const response = await route[method](new Request("http://localhost/api/jobs/price-radar-collect", { method, headers: { authorization: "Bearer test-secret" } }));
      assert.equal(response.status, 200, `${method} should succeed with the correct bearer secret`);
      const body = await response.json();
      assert.equal(body.runId, "run-1");
    });
    assert.deepEqual(claimCalls, ["owner-a"], `${method} must reach the Radar claim path`);
    assert.deepEqual(portionCalls, [{ runId: "run-1", ownerId: "owner-a", leaseToken: "lease-1" }]);
  }
});

test("the owner and collection scope come only from the server-trusted price_radar_settings table, never from request parameters", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-trusted" }];
  claimResults = { "owner-trusted": { kind: "claimed", run: { id: "run-9", leaseToken: "lease-9" } } };
  await withCronSecret("test-secret", async () => {
    // A caller-supplied ownerId/body must have no effect: the route never reads the request body.
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ ownerId: "owner-attacker-supplied", sources: ["olx"] }),
    }));
    assert.equal(response.status, 200);
  });
  assert.deepEqual(settingsCalls, ["owner-trusted"]);
  assert.deepEqual(claimCalls, ["owner-trusted"]);
  assert.deepEqual(claimCriteria, [{ ownerId: "owner-trusted", sources: ["oferty_net"], criteria: { areaMin: 31, areaMax: 62, rooms: [1, 2, 3], minPricePerSqm: 8_800, qualityRulesVersion: 2 } }]);
});

test("an owner whose Radar run is already active is skipped in favor of the next owner (existing lock/idempotency honored)", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-busy" }, { owner_id: "owner-free" }];
  claimResults = { "owner-busy": { kind: "blocked" }, "owner-free": { kind: "claimed", run: { id: "run-2", leaseToken: "lease-2" } } };
  await withCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runId, "run-2");
  });
  assert.deepEqual(claimCalls, ["owner-busy", "owner-free"]);
  assert.deepEqual(portionCalls, [{ runId: "run-2", ownerId: "owner-free", leaseToken: "lease-2" }]);
});

test("no owner ready for a portion reports idle without error", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-busy" }];
  claimResults = { "owner-busy": { kind: "blocked" } };
  await withCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "idle");
  });
  assert.deepEqual(portionCalls, []);
});
