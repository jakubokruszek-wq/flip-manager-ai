import assert from "node:assert/strict";
import test, { mock } from "node:test";

const sideEffects: string[] = [];
const forbidden = (name: string) => () => { sideEffects.push(name); throw new Error(`Retired action called ${name}`); };
let authorizationError: Error | null = null;
let authCalls = 0;
let mappedError: unknown;
const denied = new Error("operator required");
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { authCalls++; if (authorizationError) throw authorizationError; return { id: "owner-1" }; },
  operatorAuthorizationResponse: (error: unknown) => { mappedError = error; return Response.json({ message: "unauthorized" }, { status: 401 }); },
} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: forbidden("database") } });
mock.module("@/features/price-radar/server/collect", { namedExports: {
  claimOrCreateRadarRun: forbidden("claim"), resumeExistingRadarRun: forbidden("resume"), requestRadarRunStop: forbidden("stop-write"), requestRadarRunTermination: forbidden("termination-write"), runRadarCollectionPortion: forbidden("collect"), releaseRadarRunLease: forbidden("release"), recordRadarContinuationFailure: forbidden("failure-write"),
} });
mock.module("@/features/price-radar/server/radar-settings", { namedExports: { readRadarSettings: forbidden("settings"), radarSettingsSourcesWereFilteredToEmpty: forbidden("settings-filter") } });
mock.module("@/features/price-radar/server/radar-run-status", { namedExports: { latestRadarRun: forbidden("run-read") } });
mock.module("@/features/price-radar/server/radar-watchdog", { namedExports: { ensureRadarWatchdog: forbidden("watchdog") } });
mock.module("@/features/price-radar/server/radar-continuation", { namedExports: { scheduleRadarContinuation: forbidden("timer") } });
const route = await import("../../../app/api/price-radar/run/route.ts");

test("both retired run methods authorize first without exposing retirement to anonymous requests", async () => {
  authorizationError = denied;
  const before = authCalls;
  try {
    for (const handler of [route.GET, route.POST]) {
      const response = await handler();
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { message: "unauthorized" });
      assert.equal(mappedError, denied);
    }
    assert.equal(authCalls - before, 2);
    assert.deepEqual(sideEffects, []);
  } finally { authorizationError = null; }
});
test("authenticated GET is a retired status and POST is gone; neither resumes or creates work", async () => {
  const before = authCalls;
  for (const [handler, expected] of [[route.GET, 200], [route.POST, 410]] as const) {
    const response = await handler();
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    assert.equal(body.run, null);
    assert.equal(body.status, "retired");
    assert.equal(body.code, "RCN_RADAR_REPLACED_ASKING_COLLECTOR");
  }
  assert.equal(authCalls - before, 2);
  assert.deepEqual(sideEffects, []);
});
