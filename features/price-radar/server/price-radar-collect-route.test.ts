import assert from "node:assert/strict";
import test, { mock } from "node:test";

const sideEffects: string[] = [];
const forbidden = (name: string) => () => { sideEffects.push(name); throw new Error(`Retired collector called ${name}`); };
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: forbidden("database") } });
mock.module("@/features/price-radar/server/collect", { namedExports: {
  claimOrCreateRadarRun: forbidden("claim"), resumeExistingRadarRun: forbidden("resume"),
  runRadarCollectionPortion: forbidden("collect"), releaseRadarRunLease: forbidden("release"), recordRadarContinuationFailure: forbidden("failure-write"),
} });
mock.module("@/features/price-radar/server/radar-settings", { namedExports: { readRadarSettings: forbidden("settings"), radarSettingsSourcesWereFilteredToEmpty: forbidden("settings-filter") } });
mock.module("@/features/price-radar/server/radar-watchdog", { namedExports: { ensureRadarWatchdog: forbidden("watchdog") } });
mock.module("@/features/price-radar/server/radar-continuation", { namedExports: { scheduleRadarContinuation: forbidden("timer"), continueRadarAfterPortion: forbidden("continuation"), parseRadarContinuationHop: forbidden("hop"), RADAR_CONTINUATION_HOP_HEADER: "x-radar-continuation-hop", RADAR_WATCHDOG_HEADER: "x-radar-watchdog" } });
mock.module("@/features/facebook-watcher/run-after-response", { namedExports: { runAfterResponse: forbidden("after-response") } });
const route = await import("../../../app/api/jobs/price-radar-collect/route.ts");

function secret(t: { after: (callback: () => void) => void }, value?: string) {
  const previous = process.env.PRICE_RADAR_CRON_SECRET;
  if (value === undefined) delete process.env.PRICE_RADAR_CRON_SECRET;
  else process.env.PRICE_RADAR_CRON_SECRET = value;
  t.after(() => { if (previous === undefined) delete process.env.PRICE_RADAR_CRON_SECRET; else process.env.PRICE_RADAR_CRON_SECRET = previous; });
}
function request(headers: Record<string, string> = {}) { return new Request("http://localhost/api/jobs/price-radar-collect", { method: "POST", headers, body: "not-json" }); }

test("retired collector still requires its own configured secret before acknowledging retirement", async t => {
  secret(t);
  const response = await route.POST(request({ authorization: "Bearer shared-secret" }));
  assert.equal(response.status, 503);
  assert.deepEqual(sideEffects, []);
});
test("missing/wrong/shared credentials cannot access the retired collector", async t => {
  secret(t, "radar-only-secret");
  const oldShared = process.env.CRON_SECRET; process.env.CRON_SECRET = "shared-secret";
  t.after(() => { if (oldShared === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldShared; });
  for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Bearer shared-secret" }, { "x-cron-secret": "shared-secret" }, { authorization: "Bearer wrong", "x-cron-secret": "radar-only-secret" }] as Record<string, string>[]) {
    assert.equal((await route.POST(request(headers))).status, 401);
  }
  assert.deepEqual(sideEffects, []);
});
test("authenticated ticks, watchdogs and queued continuations terminate without collection, database or new timers", async t => {
  secret(t, "radar-only-secret");
  for (const headers of [
    { authorization: "Bearer radar-only-secret" },
    { "x-cron-secret": "radar-only-secret" },
    { authorization: "Bearer radar-only-secret", "x-radar-watchdog": "1" },
    { authorization: "Bearer radar-only-secret", "x-radar-continuation-hop": "2" },
  ] as Record<string, string>[]) {
    const response = await route.POST(request(headers));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { status: "completed", retired: true, reason: "RCN_RADAR_REPLACED_ASKING_COLLECTOR" });
  }
  assert.deepEqual(sideEffects, []);
});
