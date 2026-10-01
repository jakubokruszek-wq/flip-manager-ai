import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { FakeFacebookSupabase } from "../facebook-watcher/server/facebook-fake-supabase.ts";

const adminUrl = new URL("../../lib/supabase/admin.ts", import.meta.url).href;
let currentDb = new FakeFacebookSupabase();
mock.module(adminUrl, { namedExports: { createAdminClient: () => currentDb } });

const {
  getWatcherScanIntervalMinutes,
  saveWatcherScanIntervalMinutes,
} = await import("./scheduler-settings.ts");
const { schedulerCycleDecision } = await import("./scheduler-core.ts");

function freshDb() {
  const db = new FakeFacebookSupabase();
  db.seed("search_filters", [
    { id: "facebook-a", sources: ["facebook"], is_active: true, scan_interval_minutes: 60, updated_at: "2026-09-01T00:00:00Z" },
    { id: "facebook-b", sources: ["facebook", "otodom"], is_active: true, scan_interval_minutes: 60, updated_at: "2026-09-02T00:00:00Z" },
    { id: "otodom-only", sources: ["otodom"], is_active: true, scan_interval_minutes: 15, updated_at: "2026-09-03T00:00:00Z" },
    { id: "facebook-paused", sources: ["facebook"], is_active: false, scan_interval_minutes: 120, updated_at: "2026-09-04T00:00:00Z" },
  ]);
  return db;
}

test("the global Watcher interval reads the persisted active Facebook value and survives a fresh read", async () => {
  currentDb = freshDb();
  assert.equal(await getWatcherScanIntervalMinutes(), 60);
  assert.equal(await saveWatcherScanIntervalMinutes(20), 20);
  assert.equal(await getWatcherScanIntervalMinutes(), 20);
  assert.equal(currentDb.rows("search_filters").find((row) => row.id === "facebook-a")?.scan_interval_minutes, 20);
  assert.equal(currentDb.rows("search_filters").find((row) => row.id === "facebook-b")?.scan_interval_minutes, 20);
  assert.equal(currentDb.rows("search_filters").find((row) => row.id === "otodom-only")?.scan_interval_minutes, 15, "non-Facebook Finder filters are not changed");
  assert.equal(currentDb.rows("search_filters").find((row) => row.id === "facebook-paused")?.scan_interval_minutes, 120, "paused filters are not changed");
});

test("the persisted global interval is the cooldown used at the next completed Watcher cycle", async () => {
  currentDb = freshDb();
  const interval = await saveWatcherScanIntervalMinutes(30);
  const plan = [{ watchedSourceId: "group", sourceId: "group", name: "Group", url: "https://www.facebook.com/groups/group/", type: "GROUP" as const, priority: "normal" as const, createdAt: "2026-09-01T00:00:00Z" }];
  const cycleStartedAt = "2026-09-10T10:00:00Z";
  assert.deepEqual(schedulerCycleDecision({ plan, terminalSourceIds: ["group"], cycleStartedAt, cooldownMinutes: interval, nowMs: Date.parse("2026-09-10T10:29:59Z") }), { type: "WAIT_COOLDOWN", nextCycleAt: Date.parse("2026-09-10T10:30:00Z") });
  assert.deepEqual(schedulerCycleDecision({ plan, terminalSourceIds: ["group"], cycleStartedAt, cooldownMinutes: interval, nowMs: Date.parse("2026-09-10T10:30:00Z") }), { type: "START_NEXT_CYCLE", nextCycleAt: Date.parse("2026-09-10T10:30:00Z") });
});

test("the global interval keeps the historical bounded scheduler range", async () => {
  currentDb = freshDb();
  await assert.rejects(() => saveWatcherScanIntervalMinutes(4), /od 5 do 1440/);
  await assert.rejects(() => saveWatcherScanIntervalMinutes(1_441), /od 5 do 1440/);
  assert.equal(await saveWatcherScanIntervalMinutes("120"), 120);
});

test("saving without an active Facebook filter fails closed", async () => {
  currentDb = new FakeFacebookSupabase().seed("search_filters", [{ id: "otodom", sources: ["otodom"], is_active: true, scan_interval_minutes: 60 }]);
  await assert.rejects(() => saveWatcherScanIntervalMinutes(60), /WATCHER_SCAN_INTERVAL_NO_ACTIVE_FILTER/);
});
