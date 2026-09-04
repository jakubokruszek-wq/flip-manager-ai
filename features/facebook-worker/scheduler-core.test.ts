import assert from "node:assert/strict";
import test from "node:test";
import { activeJobDecision, isStaleAt, nextSchedulerSource, orderSchedulerSources, schedulerCooldownMinutes, type SchedulerSource } from "./scheduler-core.ts";

const sources: SchedulerSource[] = [
  { watchedSourceId: "2", sourceId: "second", name: "Second", url: "https://www.facebook.com/groups/second/", type: "GROUP", priority: "normal", createdAt: "2026-01-02T00:00:00Z" },
  { watchedSourceId: "1", sourceId: "first", name: "First", url: "https://www.facebook.com/groups/first/", type: "GROUP", priority: "high", createdAt: "2026-01-01T00:00:00Z" },
];

test("scheduler orders sources and returns exactly one non-terminal source", () => {
  const plan = orderSchedulerSources(sources);
  assert.deepEqual(plan.map((source) => source.sourceId), ["first", "second"]);
  assert.equal(nextSchedulerSource(plan, [], [])?.sourceId, "first");
  assert.equal(nextSchedulerSource(plan, ["first"], [])?.sourceId, "second");
  assert.equal(nextSchedulerSource(plan, ["first"], ["second"]), null);
});

test("scheduler enforces a bounded production cooldown", () => {
  assert.equal(schedulerCooldownMinutes(5), 60);
  assert.equal(schedulerCooldownMinutes(120), 120);
  assert.equal(schedulerCooldownMinutes(9_999), 1_440);
  assert.equal(schedulerCooldownMinutes(null), 1_440);
});

test("stale checks are deterministic", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");
  assert.equal(isStaleAt("2026-09-04T11:58:00Z", 90_000, now), true);
  assert.equal(isStaleAt("2026-09-04T11:59:00Z", 90_000, now), false);
  assert.equal(isStaleAt(null, 90_000, now), false);
});

test("watchdog distinguishes never-claimed, active, and no-progress jobs", () => {
  const now = Date.parse("2026-09-04T12:00:00Z");
  assert.equal(activeJobDecision({ status: "queued", attempts: 0, createdAt: "2026-09-04T11:58:00Z", heartbeatAt: null }, now), "FAIL_NEVER_CLAIMED");
  assert.equal(activeJobDecision({ status: "queued", attempts: 1, createdAt: "2026-09-04T11:00:00Z", heartbeatAt: null }, now), "WAIT");
  assert.equal(activeJobDecision({ status: "running", attempts: 1, createdAt: "2026-09-04T11:00:00Z", heartbeatAt: "2026-09-04T11:59:00Z" }, now), "WAIT");
  assert.equal(activeJobDecision({ status: "running", attempts: 1, createdAt: "2026-09-04T11:00:00Z", heartbeatAt: "2026-09-04T11:50:00Z" }, now), "FAIL_NO_PROGRESS");
  assert.equal(activeJobDecision({ status: "completed", attempts: 1, createdAt: "2026-09-04T11:00:00Z", heartbeatAt: null }, now), "RECONCILE_TERMINAL");
});
