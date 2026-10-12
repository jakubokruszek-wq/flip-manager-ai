import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { radarRunStartedTodayInWarsaw as actualRadarRunStartedTodayInWarsaw } from "./radar-scheduler.ts";

type Row = Record<string, unknown>;

let ownerRows: Row[] = [];
let runRows: Row[] = [];
let adminCalls: Array<{ op: string; table: string; payload?: Row; filters: Row }> = [];
let settingsCalls: string[] = [];
let claimCalls: string[] = [];
let resumeCalls: Array<{ ownerId: string; runId: string }> = [];
let claimCriteria: Array<{ ownerId: string; sources: unknown; criteria: unknown }> = [];
let claimResults: Record<string, { kind: "claimed"; run: { id: string; leaseToken: string } } | { kind: "blocked" }> = {};
let resumeResults: Record<string, { kind: "claimed"; run: { id: string; leaseToken: string } } | { kind: "blocked"; reason: string }> = {};
let portionCalls: Array<{ runId: string; ownerId: string; leaseToken: string }> = [];
let portionResult: Row = { status: "completed", scannedCount: 3, qualifiedCount: 1, sourceStatuses: {}, sourceErrors: {}, qualificationRejections: {} };
let latestRuns: Record<string, Row | null> = {};
let filteredToEmptyOwners: Set<string> = new Set();
let settingsByOwner: Record<string, Row> = {};
let scheduleDue = true;

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
        maybeSingle: async () => {
          adminCalls.push({ op: "maybeSingle", table, filters: { ...filters } });
          const row = (table === "price_radar_runs" ? runRows : []).find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value)) ?? null;
          return { data: row, error: null };
        },
      };
      return builder;
    },
  };
}

mock.module("@/lib/supabase/admin", { namedExports: {
  createAdminClient: () => fakeAdmin(),
} });
mock.module("@/features/price-radar/server/radar-settings", { namedExports: {
  readRadarSettings: async (ownerId: string) => { settingsCalls.push(ownerId); return { districts: [], market: "both", areaMin: 31, areaMax: 62, rooms: [1, 2, 3], sources: ["oferty_net"], minPricePerSqm: 8_800, automaticScanEnabled: true, automaticScanTime: "05:00", ...settingsByOwner[ownerId] }; },
  radarSettingsSourcesWereFilteredToEmpty: async (ownerId: string) => filteredToEmptyOwners.has(ownerId),
} });
mock.module("@/features/price-radar/server/radar-scheduler", { namedExports: {
  radarRunStartedTodayInWarsaw: actualRadarRunStartedTodayInWarsaw,
  isRadarDailyScanDue: (input: { enabled: boolean }) => scheduleDue && input.enabled,
} });
mock.module("@/features/price-radar/server/radar-run-status", { namedExports: {
  latestRadarRun: async (ownerId: string) => latestRuns[ownerId] ?? null,
} });
mock.module("@/features/price-radar/server/collect", { namedExports: {
  claimOrCreateRadarRun: async (ownerId: string, sources: unknown, _client: unknown, criteria: unknown) => { claimCalls.push(ownerId); claimCriteria.push({ ownerId, sources, criteria }); return claimResults[ownerId] ?? { kind: "blocked" }; },
  resumeExistingRadarRun: async (ownerId: string, runId: string) => { resumeCalls.push({ ownerId, runId }); return resumeResults[runId] ?? { kind: "claimed", run: { id: runId, leaseToken: "resumed-lease" } }; },
  runRadarCollectionPortion: async (input: { runId: string; ownerId: string; leaseToken: string }) => { portionCalls.push(input); return portionResult; },
} });

const route = await import("../../../app/api/jobs/price-radar-collect/route.ts");

function reset() {
  ownerRows = [];
  runRows = [];
  adminCalls = [];
  settingsCalls = [];
  claimCalls = [];
  resumeCalls = [];
  claimCriteria = [];
  claimResults = {};
  resumeResults = {};
  portionCalls = [];
  portionResult = { status: "completed", scannedCount: 3, qualifiedCount: 1, sourceStatuses: {}, sourceErrors: {}, qualificationRejections: {} };
  latestRuns = {};
  filteredToEmptyOwners = new Set();
  settingsByOwner = {};
  scheduleDue = true;
}

function withRadarCronSecret<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.PRICE_RADAR_CRON_SECRET;
  if (value === undefined) delete process.env.PRICE_RADAR_CRON_SECRET; else process.env.PRICE_RADAR_CRON_SECRET = value;
  return run().finally(() => { if (previous === undefined) delete process.env.PRICE_RADAR_CRON_SECRET; else process.env.PRICE_RADAR_CRON_SECRET = previous; });
}

test("missing PRICE_RADAR_CRON_SECRET server configuration rejects the request before any Radar work starts", async () => {
  reset();
  await withRadarCronSecret(undefined, async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST" }));
    assert.equal(response.status, 503);
  });
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("a request with no Authorization header is rejected before any Radar work starts", async () => {
  reset();
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST" }));
    assert.equal(response.status, 401);
  });
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("an incorrect secret is rejected before any Radar work starts", async () => {
  reset();
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer wrong-secret" } }));
    assert.equal(response.status, 401);
  });
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("the shared CRON_SECRET used by Finder/Facebook Watch is a different credential and never authorizes this endpoint", async () => {
  reset();
  const previousShared = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "finder-and-facebook-watch-shared-secret";
  try {
    await withRadarCronSecret(undefined, async () => {
      const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", {
        method: "POST", headers: { authorization: "Bearer finder-and-facebook-watch-shared-secret" },
      }));
      assert.equal(response.status, 503, "PRICE_RADAR_CRON_SECRET is unset, so the shared CRON_SECRET's value must not be accepted as a fallback");
    });
    await withRadarCronSecret("radar-only-secret", async () => {
      const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", {
        method: "POST", headers: { authorization: "Bearer finder-and-facebook-watch-shared-secret" },
      }));
      assert.equal(response.status, 401, "the shared CRON_SECRET's value is not the Radar-only secret and must still be rejected");
    });
  } finally {
    if (previousShared === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previousShared;
  }
  assert.deepEqual(adminCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("the correct secret as a bare Vercel Cron Authorization: Bearer header runs the job with no browser session, via both GET and POST", async () => {
  for (const method of ["GET", "POST"] as const) {
    reset();
    ownerRows = [{ owner_id: "owner-a" }];
    claimResults = { "owner-a": { kind: "claimed", run: { id: "run-1", leaseToken: "lease-1" } } };
    await withRadarCronSecret("test-secret", async () => {
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
  await withRadarCronSecret("test-secret", async () => {
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
  assert.deepEqual(claimCriteria, [{ ownerId: "owner-trusted", sources: ["oferty_net"], criteria: { areaMin: 31, areaMax: 62, rooms: [1, 2, 3], minPricePerSqm: 8_800, districts: [], qualityRulesVersion: 2 } }]);
});

test("an owner whose Radar run is already active is skipped in favor of the next owner (existing lock/idempotency honored)", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-busy" }, { owner_id: "owner-free" }];
  claimResults = { "owner-busy": { kind: "blocked" }, "owner-free": { kind: "claimed", run: { id: "run-2", leaseToken: "lease-2" } } };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runId, "run-2");
  });
  assert.deepEqual(claimCalls, ["owner-busy", "owner-free"]);
  assert.deepEqual(portionCalls, [{ runId: "run-2", ownerId: "owner-free", leaseToken: "lease-2" }]);
});

test("an owner whose saved selection was filtered to empty by a disabled source (szybko) is skipped entirely -- never silently scanned on every active source", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-szybko-only" }, { owner_id: "owner-free" }];
  filteredToEmptyOwners = new Set(["owner-szybko-only"]);
  claimResults = { "owner-free": { kind: "claimed", run: { id: "run-3", leaseToken: "lease-3" } } };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.runId, "run-3");
  });
  assert.deepEqual(claimCalls, ["owner-free"], "the filtered-to-empty owner must never reach claimOrCreateRadarRun at all");
  assert.deepEqual(portionCalls, [{ runId: "run-3", ownerId: "owner-free", leaseToken: "lease-3" }]);
});

test("no owner ready for a portion reports idle without error", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-busy" }];
  claimResults = { "owner-busy": { kind: "blocked" } };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, "idle");
  });
  assert.deepEqual(portionCalls, []);
});

test("disabled automation returns an honest no-op and does not claim or resume a run", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  settingsByOwner["owner-a"] = { automaticScanEnabled: false };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.deepEqual(await response.json(), { status: "automation_disabled" });
  });
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("before the saved daily time a tick returns not_due and does not create a run", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  scheduleDue = false;
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.deepEqual(await response.json(), { status: "not_due" });
  });
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("an active checkpoint is continued before the due-time check and keeps the same run id", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  latestRuns["owner-a"] = { id: "existing-checkpoint", status: "running", startedAt: "2026-10-11T03:10:00.000Z", stopRequestedAt: null, userTerminatedAt: null, leaseUntil: new Date(Date.now() - 1_000).toISOString(), errorMessage: null };
  scheduleDue = false;
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal((await response.json()).runId, "existing-checkpoint");
  });
  assert.deepEqual(resumeCalls, [{ ownerId: "owner-a", runId: "existing-checkpoint" }]);
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, [{ runId: "existing-checkpoint", ownerId: "owner-a", leaseToken: "resumed-lease" }]);
});

test("an exact-run continuation stops after automation is disabled and preserves the checkpoint", async () => {
  reset();
  const runId = "123e4567-e89b-42d3-a456-426614174003";
  ownerRows = [{ owner_id: "owner-a" }];
  runRows = [{ id: runId, owner_id: "owner-a", status: "running", checkpoint: { sourceQueue: ["oferty_net"] }, scanned_count: 5, qualified_count: 1 }];
  settingsByOwner["owner-a"] = { automaticScanEnabled: false };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret", "content-type": "application/json" }, body: JSON.stringify({ runId }) }));
    assert.deepEqual(await response.json(), { runId, status: "automation_disabled" });
  });
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("a terminal run already started today in Warsaw cannot be replaced by a duplicate daily start", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  latestRuns["owner-a"] = { id: "same-day-run", status: "partial", startedAt: "2026-10-12T03:10:00.000Z", stopRequestedAt: null, userTerminatedAt: null, leaseUntil: null, errorMessage: "oferty_net: source returned partial coverage" };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "already_ran_today" });
  });
  assert.deepEqual(claimCalls, [], "same-day retries must not allocate a second run");
  assert.deepEqual(portionCalls, []);
});

test("an active lease is reported as waiting and is never claimed a second time", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  latestRuns["owner-a"] = { id: "active-run", status: "running", startedAt: "2026-10-11T03:10:00.000Z", stopRequestedAt: null, userTerminatedAt: null, leaseUntil: new Date(Date.now() + 30_000).toISOString(), errorMessage: null };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    const body = await response.json();
    assert.equal(body.runId, "active-run");
    assert.equal(body.status, "waiting");
    assert.ok(body.retryAfterSeconds >= 30 && body.retryAfterSeconds <= 32);
  });
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("an expired active checkpoint resumes its existing run ID instead of allocating a fresh run", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  latestRuns["owner-a"] = { id: "checkpoint-run", status: "running", startedAt: "2026-10-11T03:10:00.000Z", stopRequestedAt: null, userTerminatedAt: null, leaseUntil: new Date(Date.now() - 1_000).toISOString(), errorMessage: null };
  resumeResults["checkpoint-run"] = { kind: "claimed", run: { id: "checkpoint-run", leaseToken: "new-fenced-lease" } };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal((await response.json()).runId, "checkpoint-run");
  });
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(resumeCalls, [{ ownerId: "owner-a", runId: "checkpoint-run" }]);
  assert.deepEqual(portionCalls, [{ runId: "checkpoint-run", ownerId: "owner-a", leaseToken: "new-fenced-lease" }]);
});

test("a scheduler continuation is restricted to its exact server-owned run ID", async () => {
  reset();
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  runRows = [{ id: runId, owner_id: "owner-from-db", status: "running", lease_until: new Date(Date.now() - 1_000).toISOString(), stop_requested_at: null, user_terminated_at: null, checkpoint: {}, source_statuses: {} }];
  resumeResults[runId] = { kind: "claimed", run: { id: runId, leaseToken: "exact-run-lease" } };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", {
      method: "POST",
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      body: JSON.stringify({ runId, ownerId: "caller-cannot-pick-owner", sources: ["facebook"] }),
    }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).runId, runId);
  });
  assert.deepEqual(resumeCalls, [{ ownerId: "owner-from-db", runId }]);
  assert.deepEqual(claimCalls, [], "an exact continuation path cannot create a replacement run");
  assert.deepEqual(settingsCalls, ["owner-from-db"], "the exact run's saved automation flag is read for its database-owned owner; request settings cannot replace it");
  assert.deepEqual(portionCalls, [{ runId, ownerId: "owner-from-db", leaseToken: "exact-run-lease" }]);
});

test("an exact terminal run returns its actual final state without resuming or creating work", async () => {
  reset();
  const runId = "123e4567-e89b-42d3-a456-426614174000";
  runRows = [{ id: runId, owner_id: "owner-from-db", status: "partial", lease_until: null, stop_requested_at: null, user_terminated_at: null, scanned_count: 12, qualified_count: 2, source_statuses: { morizon: "failed" }, checkpoint: { sourceErrors: { morizon: "HTTP 503" } } }];
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", {
      method: "POST", headers: { authorization: "Bearer test-secret", "content-type": "application/json" }, body: JSON.stringify({ runId }),
    }));
    const body = await response.json();
    assert.equal(body.status, "partial");
    assert.equal(body.terminal, true);
    assert.equal(body.scannedCount, 12);
  });
  assert.deepEqual(resumeCalls, []);
  assert.deepEqual(portionCalls, []);
  assert.deepEqual(claimCalls, []);
});

test("an explicit operator pause is not automatically resumed", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  latestRuns["owner-a"] = { id: "paused-run", status: "partial", startedAt: "2026-10-10T03:10:00.000Z", stopRequestedAt: "2026-10-10T04:00:00.000Z", userTerminatedAt: null, leaseUntil: null, errorMessage: "RADAR_STOPPED_BY_OPERATOR" };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.deepEqual(await response.json(), { runId: "paused-run", status: "paused_by_operator" });
  });
  assert.deepEqual(claimCalls, []);
  assert.deepEqual(portionCalls, []);
});

test("portal partial errors stay terminal and OLX waiting is reported without claiming the whole run complete", async () => {
  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  claimResults = { "owner-a": { kind: "claimed", run: { id: "run-partial", leaseToken: "lease" } } };
  portionResult = { status: "partial", scannedCount: 8, qualifiedCount: 2, sourceStatuses: { morizon: "failed" }, sourceErrors: { morizon: "HTTP 503" }, qualificationRejections: {} };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    assert.equal((await response.json()).status, "partial");
  });

  reset();
  ownerRows = [{ owner_id: "owner-a" }];
  claimResults = { "owner-a": { kind: "claimed", run: { id: "run-olx", leaseToken: "lease" } } };
  portionResult = { status: "running", scannedCount: 8, qualifiedCount: 2, sourceStatuses: { olx: "running" }, sourceErrors: {}, qualificationRejections: {} };
  await withRadarCronSecret("test-secret", async () => {
    const response = await route.POST(new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers: { authorization: "Bearer test-secret" } }));
    const body = await response.json();
    assert.equal(body.status, "waiting_for_olx");
    assert.equal(body.runId, "run-olx");
    assert.equal(body.retryAfterSeconds, 300);
  });
});
