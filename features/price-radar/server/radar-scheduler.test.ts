import assert from "node:assert/strict";
import test from "node:test";
import { isRadarDailyScanDue, nextRadarDailyScanAt, radarRunStartedTodayInWarsaw, warsawDateKey } from "./radar-scheduler.ts";

test("daily identity follows the Warsaw calendar through CET/CEST changes", () => {
  assert.equal(warsawDateKey("2026-01-13T04:00:00.000Z"), "2026-01-13", "05:00 CET belongs to the Polish local day");
  assert.equal(warsawDateKey("2026-07-13T03:00:00.000Z"), "2026-07-13", "05:00 CEST belongs to the Polish local day");
  assert.equal(warsawDateKey("2026-10-25T00:30:00.000Z"), "2026-10-25", "the repeated autumn DST hour remains the same local date");
});

test("a terminal run is an idempotency guard only for its Warsaw day", () => {
  assert.equal(radarRunStartedTodayInWarsaw("2026-10-12T03:05:00.000Z", new Date("2026-10-12T20:00:00.000Z")), true);
  assert.equal(radarRunStartedTodayInWarsaw("2026-10-11T21:30:00.000Z", new Date("2026-10-12T03:00:00.000Z")), false);
  assert.equal(radarRunStartedTodayInWarsaw("not-a-date", new Date("2026-10-12T03:00:00.000Z")), false);
});

test("the saved daily wall-clock time is honored across winter and summer offsets", () => {
  assert.equal(isRadarDailyScanDue({ enabled: true, time: "05:00" }, new Date("2026-01-13T03:59:00Z")), false);
  assert.equal(isRadarDailyScanDue({ enabled: true, time: "05:00" }, new Date("2026-01-13T04:00:00Z")), true, "05:00 CET is 04:00 UTC");
  assert.equal(isRadarDailyScanDue({ enabled: true, time: "05:00" }, new Date("2026-07-13T02:59:00Z")), false);
  assert.equal(isRadarDailyScanDue({ enabled: true, time: "05:00" }, new Date("2026-07-13T03:00:00Z")), true, "05:00 CEST is 03:00 UTC");
  assert.equal(isRadarDailyScanDue({ enabled: false, time: "00:00" }, new Date("2026-07-13T12:00:00Z")), false);
  assert.equal(isRadarDailyScanDue({ enabled: true, time: "25:00" }, new Date("2026-07-13T12:00:00Z")), false);
});

test("the scheduled start is idempotent on each local day and advances through CET/CEST", () => {
  const winter = nextRadarDailyScanAt({ enabled: true, time: "05:00" }, new Date("2026-01-13T03:59:00Z"));
  assert.equal(winter?.toISOString(), "2026-01-13T04:00:00.000Z");
  const summer = nextRadarDailyScanAt({ enabled: true, time: "05:00" }, new Date("2026-07-13T02:59:00Z"));
  assert.equal(summer?.toISOString(), "2026-07-13T03:00:00.000Z");
  const springForward = nextRadarDailyScanAt({ enabled: true, time: "05:00" }, new Date("2026-03-29T01:00:00Z"));
  assert.equal(springForward?.toISOString(), "2026-03-29T03:00:00.000Z");
  const autumnBack = nextRadarDailyScanAt({ enabled: true, time: "05:00" }, new Date("2026-10-25T02:00:00Z"));
  assert.equal(autumnBack?.toISOString(), "2026-10-25T04:00:00.000Z");
  const startedToday = nextRadarDailyScanAt({ enabled: true, time: "05:00", lastStartedAt: "2026-07-13T03:02:00Z" }, new Date("2026-07-13T04:00:00Z"));
  assert.equal(startedToday?.toISOString(), "2026-07-14T03:00:00.000Z");
  assert.equal(nextRadarDailyScanAt({ enabled: false, time: "05:00" }), null);
});
