import assert from "node:assert/strict";
import test from "node:test";
import { activeJobDecision, isStaleAt, nextSchedulerSource, orderSchedulerSources, schedulerCooldownMinutes, schedulerCycleDecision, withExclusiveSchedulerLock, type SchedulerSource } from "./scheduler-core.ts";

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

test("scheduler removes duplicate watched rows for the same canonical source", () => {
  const duplicate = { ...sources[1], watchedSourceId: "duplicate", createdAt: "2026-01-03T00:00:00Z" };
  assert.deepEqual(orderSchedulerSources([...sources, duplicate]).map((source) => source.sourceId), ["first", "second"]);
});

test("parallel scheduler invocations execute the protected task exactly once", async () => {
  let owner: string | null = null;
  let executions = 0;
  let releaseTask!: () => void;
  const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
  const invoke = () => withExclusiveSchedulerLock({
    acquire: async () => { if (owner) return null; owner = "generation-1"; return owner; },
    release: async (candidate) => { if (owner === candidate) owner = null; },
    task: async () => { executions += 1; await taskGate; return "STARTED"; },
  });
  const first = invoke();
  await Promise.resolve();
  const second = invoke();
  releaseTask();
  assert.deepEqual(await Promise.all([first, second]), ["STARTED", null]);
  assert.equal(executions, 1);
});

test("restart reconstructs the same next source and terminal transition is deterministic", () => {
  const plan = orderSchedulerSources(sources);
  const input = { plan, terminalSourceIds: ["first"], cycleStartedAt: "2026-09-04T10:00:00Z", cooldownMinutes: 60, nowMs: Date.parse("2026-09-04T10:30:00Z") };
  assert.deepEqual(schedulerCycleDecision(input), { type: "ADVANCE", source: plan[1] });
  assert.deepEqual(schedulerCycleDecision(input), { type: "ADVANCE", source: plan[1] });
});

test("completed cycle waits for cooldown and starts exactly when scheduled", () => {
  const plan = orderSchedulerSources(sources);
  const base = { plan, terminalSourceIds: ["first", "second"], cycleStartedAt: "2026-09-04T10:00:00Z", cooldownMinutes: 60 };
  assert.deepEqual(schedulerCycleDecision({ ...base, nowMs: Date.parse("2026-09-04T10:59:59Z") }), { type: "WAIT_COOLDOWN", nextCycleAt: Date.parse("2026-09-04T11:00:00Z") });
  assert.deepEqual(schedulerCycleDecision({ ...base, nowMs: Date.parse("2026-09-04T11:00:00Z") }), { type: "START_NEXT_CYCLE", nextCycleAt: Date.parse("2026-09-04T11:00:00Z") });
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
