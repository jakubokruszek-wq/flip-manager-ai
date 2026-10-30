import assert from "node:assert/strict";
import test from "node:test";
import { readDailySchedule, dailyCycleDecision } from "./daily-schedule.ts";
const schedule = readDailySchedule("08:00,14:00,20:00")!;
const decide = (now: string, last: string | null = null) => dailyCycleDecision(schedule, new Date(now), last);

test("Warsaw winter: no run before 08:00, exact boundaries, one cycle per slot", () => {
  assert.deepEqual(decide("2026-10-30T06:59:59Z"), { due: false, slot: null, nextCycleAt: "2026-10-30T07:00:00.000Z" });
  assert.equal(decide("2026-10-30T07:00:00Z").due, true);
  assert.equal(decide("2026-10-30T07:05:00Z", "2026-10-30T07:00:00Z").due, false);
  assert.equal(decide("2026-10-30T13:00:00Z", "2026-10-30T07:00:00Z").due, true);
  assert.equal(decide("2026-10-30T19:00:00Z", "2026-10-30T13:00:00Z").due, true);
  assert.equal(decide("2026-10-30T20:00:00Z", "2026-10-30T19:00:00Z").nextCycleAt, "2026-10-31T07:00:00.000Z");
});
test("summer and DST transitions retain Polish clock times", () => {
  for (const day of ["2026-03-29", "2026-07-01", "2026-10-24"]) assert.equal(decide(`${day}T06:00:00Z`).due, true);
  assert.equal(decide("2026-03-28T20:00:00Z", "2026-03-28T19:00:00Z").nextCycleAt, "2026-03-29T06:00:00.000Z");
  assert.equal(decide("2026-10-24T20:00:00Z", "2026-10-24T18:00:00Z").nextCycleAt, "2026-10-25T07:00:00.000Z");
});
test("outage coalesces missed slots into one catch-up, no replay storm overnight", () => {
  assert.equal(decide("2026-10-30T17:00:00Z", "2026-10-29T19:00:00Z").slot, "2026-10-30T13:00:00.000Z");
  assert.equal(decide("2026-10-30T17:01:00Z", "2026-10-30T17:00:00Z").due, false);
  assert.equal(decide("2026-10-31T05:00:00Z", "2026-10-29T19:00:00Z").due, false);
});
test("frequency is configurable; unset preserves interval mode; malformed configuration fails closed", () => {
  assert.equal(readDailySchedule(undefined), null);
  assert.equal(readDailySchedule(" "), null);
  assert.deepEqual(readDailySchedule("20:00,08:00")?.times, ["08:00", "20:00"]);
  assert.equal(readDailySchedule("08:00,10:00,12:00,14:00,16:00,18:00,20:00")?.times.length, 7);
  for (const value of ["24:00", "8:00", "08:00,08:00", "08:60", "02:30", "08:00,", "null"]) assert.throws(() => readDailySchedule(value));
  assert.throws(() => decide("bad-date"));
  assert.throws(() => decide("2026-10-30T07:00:00Z", "bad-date"));
});
