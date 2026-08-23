import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenAICostDashboard } from "./scan-cost.ts";

test("aggregates last run, today and month without counting a cache hit", () => {
  const first = summary({ calls: 1, totalTokens: 1_500, costUsd: 0.00045 });
  const second = summary({ calls: 1, totalTokens: 2_000, costUsd: 0.0006 });
  const cacheHit = summary({ calls: 0, totalTokens: 0, costUsd: 0 });
  const dashboard = buildOpenAICostDashboard({
    runResults: [first, cacheHit],
    monthJobs: [
      { finishedAt: "2026-08-22T10:00:00.000Z", resultSummary: second },
      { finishedAt: "2026-08-23T10:00:00.000Z", resultSummary: first },
      { finishedAt: "2026-08-23T10:01:00.000Z", resultSummary: cacheHit },
    ],
    todayStart: "2026-08-23T00:00:00.000Z",
    monthlyBudgetUsd: 10,
  });
  assert.equal(dashboard.lastRun.calls, 1);
  assert.equal(dashboard.lastRun.totalTokens, 1_500);
  assert.equal(dashboard.today.calls, 1);
  assert.equal(dashboard.month.calls, 2);
  assert.equal(dashboard.month.totalTokens, 3_500);
  assert.equal(dashboard.month.costUsd, 0.00105);
  assert.equal(dashboard.remainingBudgetUsd, 9.99895);
});

test("reports partial and unavailable usage quality without estimating missing cost", () => {
  const exact = summary({ calls: 1, totalTokens: 1_500, costUsd: 0.00045 });
  const unavailable = summary({ calls: 1, totalTokens: 0, costUsd: null, unavailable: 1 });
  const partial = buildOpenAICostDashboard({ runResults: [exact, unavailable], monthJobs: [], todayStart: "2026-08-23T00:00:00.000Z", monthlyBudgetUsd: null });
  const missing = buildOpenAICostDashboard({ runResults: [unavailable], monthJobs: [], todayStart: "2026-08-23T00:00:00.000Z", monthlyBudgetUsd: null });
  assert.equal(partial.lastRun.dataQuality, "PARTIAL");
  assert.equal(partial.lastRun.costUsd, 0.00045);
  assert.equal(missing.lastRun.dataQuality, "UNAVAILABLE");
  assert.equal(missing.lastRun.costUsd, null);
  assert.equal(missing.remainingBudgetUsd, null);
});

function summary(input: { calls: number; totalTokens: number; costUsd: number | null; unavailable?: number }) {
  return {
    openaiVision: {
      calls: input.calls,
      inputTokens: Math.floor(input.totalTokens * 2 / 3),
      outputTokens: Math.ceil(input.totalTokens / 3),
      totalTokens: input.totalTokens,
      cachedInputTokens: 0,
      usageUnavailableCalls: input.unavailable ?? 0,
      models: ["gpt-4o-mini"],
    },
    visionCostUsd: input.costUsd,
    visionCostDataQuality: input.unavailable ? "UNAVAILABLE" : "EXACT",
    visionPricingSourceModels: ["gpt-4o-mini"],
  };
}
