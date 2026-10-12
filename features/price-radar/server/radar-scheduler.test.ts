import assert from "node:assert/strict";
import test from "node:test";
import { radarRunStartedTodayInWarsaw, warsawDateKey } from "./radar-scheduler.ts";

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
