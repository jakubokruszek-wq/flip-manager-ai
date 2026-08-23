import assert from "node:assert/strict";
import test from "node:test";

import { budgetTone, buildOverallProgress, calculateBudget, isTerminalScanStatus, type ScanWorkUnit } from "./scan-progress.ts";

const completed = (index: number): ScanWorkUnit => unit(index, "completed");
const pending = (index: number): ScanWorkUnit => unit(index, "pending");

for (const [done, expectedPercent] of [[0, 0], [1, 33], [2, 67], [3, 100]] as const) {
  test(`real work-unit progress reports ${done}/3`, () => {
    const units = [0, 1, 2].map((index) => index < done ? completed(index) : pending(index));
    const progress = buildOverallProgress(units, done === 0 ? ["queued", "queued", "queued"] : ["running"]);
    assert.equal(progress.completedUnits, done);
    assert.equal(progress.totalUnits, 3);
    assert.equal(progress.percent, expectedPercent);
    assert.equal(progress.status, done === 0 ? "queued" : done === 3 ? "completed" : "running");
  });
}

test("failed terminal unit produces partial run and polling stops", () => {
  const progress = buildOverallProgress([completed(0), completed(1), unit(2, "failed")], ["completed", "completed", "failed"]);
  assert.equal(progress.status, "partial");
  assert.equal(progress.completedUnits, 3);
  assert.equal(progress.failedUnits, 1);
  assert.equal(isTerminalScanStatus(progress.status), true);
});

test("all failed work produces failed terminal run", () => {
  const progress = buildOverallProgress([unit(0, "failed"), unit(1, "failed")], ["failed", "failed"]);
  assert.equal(progress.status, "failed");
  assert.equal(isTerminalScanStatus(progress.status), true);
});

test("inactive sources are excluded because only persisted run work units are counted", () => {
  const progress = buildOverallProgress([unit(0, "completed", "olx"), unit(1, "running", "facebook")], ["completed", "running"]);
  assert.equal(progress.totalUnits, 2);
  assert.equal(progress.completedUnits, 1);
  assert.equal(progress.percent, 50);
});

test("monthly budget calculates remaining amount and thresholds", () => {
  assert.deepEqual(calculateBudget(25, 100), { remainingBudgetUsd: 75, budgetUsedPercent: 25 });
  assert.equal(budgetTone(49.99), "normal");
  assert.equal(budgetTone(50), "info");
  assert.equal(budgetTone(80), "warning");
  assert.equal(budgetTone(95), "critical");
});

test("missing monthly budget omits remaining amount without crashing", () => {
  assert.deepEqual(calculateBudget(12, null), { remainingBudgetUsd: null, budgetUsedPercent: null });
  assert.equal(budgetTone(null), "normal");
});

function unit(index: number, status: ScanWorkUnit["status"], source: ScanWorkUnit["source"] = "facebook"): ScanWorkUnit {
  return {
    id: `unit-${index}`, source, status, startedAt: "2026-08-23T10:00:00.000Z",
    finishedAt: status === "completed" || status === "failed" ? "2026-08-23T10:01:00.000Z" : null,
    scannedCount: 0, matchedCount: 0, normalizedCount: 0, errorMessage: status === "failed" ? "failure" : null,
  };
}
