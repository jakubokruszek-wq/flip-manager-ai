import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFacebookVisionRun, calculateOpenAIVisionCost, captureOpenAIResponseUsage, OPENAI_PRICING_VERSION, summarizeFacebookVisionUsage } from "./openai-pricing.ts";
import type { FacebookVisionExtraction, FacebookVisionUsage } from "./types.ts";

function usage(overrides: Partial<FacebookVisionUsage> = {}): FacebookVisionUsage {
  return {
    inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, cachedInputTokens: 0, reasoningTokens: 0,
    model: "gpt-4o-mini", requestId: "req_test", estimatedCostUsd: 0.00045, pricingSourceModel: "gpt-4o-mini",
    pricingVersion: OPENAI_PRICING_VERSION, dataQuality: "EXACT", diagnosticsReason: null, ...overrides,
  };
}

function vision(value: FacebookVisionUsage): FacebookVisionExtraction {
  return { usage: value } as FacebookVisionExtraction;
}

test("full usage calculates exact gpt-4o-mini token sums and cost", () => {
  const captured = captureOpenAIResponseUsage({ model: "gpt-4o-mini", usage: { input_tokens: 1_000, output_tokens: 500, total_tokens: 1_500, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 25 } } }, "gpt-4o-mini", "req_123");
  assert.deepEqual({ input: captured.inputTokens, output: captured.outputTokens, total: captured.totalTokens, reasoning: captured.reasoningTokens }, { input: 1_000, output: 500, total: 1_500, reasoning: 25 });
  assert.equal(captured.estimatedCostUsd, 0.00045);
  assert.equal(captured.dataQuality, "EXACT");
  assert.equal(captured.requestId, "req_123");
});

test("two calls aggregate tokens and cost", () => {
  const summary = summarizeFacebookVisionUsage([vision(usage()), vision(usage({ inputTokens: 200, outputTokens: 100, totalTokens: 300, estimatedCostUsd: 0.00009 }))], 2);
  assert.deepEqual(summary.openaiVision, { calls: 2, inputTokens: 1_200, outputTokens: 600, totalTokens: 1_800, cachedInputTokens: 0, usageUnavailableCalls: 0, models: ["gpt-4o-mini"] });
  assert.equal(summary.visionCostUsd, 0.00054);
  assert.equal(summary.visionCostDataQuality, "EXACT");
});

test("cache hit adds no second Vision call, tokens, or cost", () => {
  const first = summarizeFacebookVisionUsage([vision(usage())], 1);
  const cached = summarizeFacebookVisionUsage([], 0);
  const run = aggregateFacebookVisionRun([first, cached]);
  assert.equal(run.visionCalls, 1);
  assert.equal(run.visionInputTokens, 1_000);
  assert.equal(run.visionCostUsd, 0.00045);
});

test("missing provider usage does not crash and is unavailable", () => {
  const captured = captureOpenAIResponseUsage({ model: "gpt-4o-mini" }, "gpt-4o-mini");
  assert.equal(captured.inputTokens, null);
  assert.equal(captured.estimatedCostUsd, null);
  assert.equal(captured.diagnosticsReason, "OPENAI_USAGE_UNAVAILABLE");
  const summary = summarizeFacebookVisionUsage([vision(captured)], 1);
  assert.equal(summary.openaiVision.usageUnavailableCalls, 1);
  assert.equal(summary.visionCostUsd, null);
  assert.equal(summary.visionCostDataQuality, "UNAVAILABLE");
});

test("partial usage across calls reports partial cost quality", () => {
  const summary = summarizeFacebookVisionUsage([vision(usage()), vision(usage({ inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null, dataQuality: "UNAVAILABLE", diagnosticsReason: "OPENAI_USAGE_UNAVAILABLE" }))], 2);
  assert.equal(summary.visionCostUsd, 0.00045);
  assert.equal(summary.visionCostDataQuality, "PARTIAL");
  assert.equal(summary.openaiVision.usageUnavailableCalls, 1);
});

test("provider usage without total tokens keeps calculable cost as partial", () => {
  const captured = captureOpenAIResponseUsage({ model: "gpt-4o-mini", usage: { input_tokens: 1_000, output_tokens: 500 } }, "gpt-4o-mini");
  assert.equal(captured.totalTokens, null);
  assert.equal(captured.estimatedCostUsd, 0.00045);
  assert.equal(captured.dataQuality, "PARTIAL");
  const summary = summarizeFacebookVisionUsage([vision(captured)], 1);
  assert.equal(summary.visionCostUsd, 0.00045);
  assert.equal(summary.visionCostDataQuality, "PARTIAL");
});

test("mixed models are priced per call with their own rates", () => {
  const mini = usage();
  const gpt4oCost = calculateOpenAIVisionCost({ model: "gpt-4o", inputTokens: 1_000, outputTokens: 500 });
  assert.ok(gpt4oCost);
  const gpt4o = usage({ model: "gpt-4o", estimatedCostUsd: gpt4oCost.estimatedCostUsd, pricingSourceModel: "gpt-4o" });
  const summary = summarizeFacebookVisionUsage([vision(mini), vision(gpt4o)], 2);
  assert.deepEqual(summary.openaiVision.models, ["gpt-4o-mini", "gpt-4o"]);
  assert.equal(summary.visionCostUsd, 0.00795);
});

test("cached input uses the lower official rate", () => {
  const cost = calculateOpenAIVisionCost({ model: "gpt-4o-mini", inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 500 });
  assert.equal(cost?.estimatedCostUsd, 0.00042);
});

test("result summary remains JSON serializable with per-call usage metrics", () => {
  const summary = summarizeFacebookVisionUsage([vision(usage())], 1);
  const serialized = JSON.parse(JSON.stringify({ source: "facebook", ...summary, openaiVisionCalls: [{ postId: "post-1", usage: usage() }] })) as typeof summary & { source: string; openaiVisionCalls: Array<{ postId: string; usage: FacebookVisionUsage }> };
  assert.equal(serialized.source, "facebook");
  assert.equal(serialized.openaiVision.totalTokens, 1_500);
  assert.equal(serialized.visionCostDataQuality, "EXACT");
  assert.equal(serialized.openaiVisionCalls[0].usage.requestId, "req_test");
});
