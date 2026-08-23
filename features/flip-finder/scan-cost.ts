import { aggregateFacebookVisionRun } from "../facebook-worker/openai-pricing.ts";
import { calculateBudget, type OpenAICostWindow } from "./scan-progress.ts";

export type CompletedVisionJob = { finishedAt: string; resultSummary: unknown };

export function buildOpenAICostDashboard(input: {
  runResults: unknown[];
  monthJobs: CompletedVisionJob[];
  todayStart: string;
  monthlyBudgetUsd: number | null;
}) {
  const lastRun = costWindow(input.runResults);
  const month = costWindow(input.monthJobs.map((job) => job.resultSummary));
  const today = costWindow(input.monthJobs.filter((job) => job.finishedAt >= input.todayStart).map((job) => job.resultSummary));
  return { lastRun, today, month, ...calculateBudget(month.costUsd, input.monthlyBudgetUsd) };
}

export function costWindow(resultSummaries: unknown[]): OpenAICostWindow {
  const result = aggregateFacebookVisionRun(resultSummaries);
  return {
    calls: result.visionCalls,
    inputTokens: result.visionInputTokens,
    outputTokens: result.visionOutputTokens,
    totalTokens: result.visionTotalTokens,
    cachedInputTokens: result.visionCachedInputTokens,
    costUsd: result.visionCostUsd,
    dataQuality: result.visionCostDataQuality,
    models: result.openaiVision.models,
  };
}
