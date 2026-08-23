import type { FacebookOpenAIVisionSummary, FacebookVisionCostDataQuality, FacebookVisionExtraction, FacebookVisionUsage } from "./types.ts";

export const OPENAI_PRICING_VERSION = "2026-08-23";
export const OPENAI_PRICING_SOURCE_URL = "https://developers.openai.com/api/docs/models/gpt-4o-mini";

type ModelPricing = {
  sourceModel: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

const PRICING: Record<string, ModelPricing> = {
  "gpt-4o-mini": { sourceModel: "gpt-4o-mini", inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 0.6 },
  "gpt-4o-mini-2024-07-18": { sourceModel: "gpt-4o-mini", inputUsdPerMillion: 0.15, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 0.6 },
  "gpt-4o": { sourceModel: "gpt-4o", inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
  "gpt-4o-2024-08-06": { sourceModel: "gpt-4o", inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 1.25, outputUsdPerMillion: 10 },
};

export type FacebookVisionCostSummary = {
  openaiVision: FacebookOpenAIVisionSummary;
  visionCostUsd: number | null;
  visionCostDataQuality: FacebookVisionCostDataQuality;
  visionPricingSourceModels: string[];
  visionPricingVersion: string;
};

export type FacebookVisionRunCostSummary = FacebookVisionCostSummary & {
  visionCalls: number;
  visionInputTokens: number;
  visionOutputTokens: number;
  visionTotalTokens: number;
  visionCachedInputTokens: number;
  visionUsageUnavailableCalls: number;
};

export function captureOpenAIResponseUsage(payload: unknown, requestedModel: string, requestId: string | null = null): FacebookVisionUsage {
  const response = record(payload);
  const usage = record(response?.usage);
  const inputDetails = record(usage?.input_tokens_details);
  const outputDetails = record(usage?.output_tokens_details);
  const model = stringValue(response?.model) ?? requestedModel;
  const inputTokens = tokenValue(usage?.input_tokens);
  const outputTokens = tokenValue(usage?.output_tokens);
  const totalTokens = tokenValue(usage?.total_tokens);
  const cachedInputTokens = tokenValue(inputDetails?.cached_tokens);
  const reasoningTokens = tokenValue(outputDetails?.reasoning_tokens);
  const usageAvailable = inputTokens !== null && outputTokens !== null && totalTokens !== null;
  const usagePartiallyAvailable = inputTokens !== null || outputTokens !== null || totalTokens !== null;
  const cost = inputTokens !== null && outputTokens !== null
    ? calculateOpenAIVisionCost({ model, inputTokens, outputTokens, cachedInputTokens: cachedInputTokens ?? 0 })
    : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
    model,
    requestId,
    estimatedCostUsd: cost?.estimatedCostUsd ?? null,
    pricingSourceModel: cost?.pricingSourceModel ?? null,
    pricingVersion: OPENAI_PRICING_VERSION,
    dataQuality: usageAvailable && cost ? "EXACT" : usagePartiallyAvailable && cost ? "PARTIAL" : "UNAVAILABLE",
    diagnosticsReason: usageAvailable ? null : "OPENAI_USAGE_UNAVAILABLE",
  };
}

export function calculateOpenAIVisionCost(input: { model: string; inputTokens: number; outputTokens: number; cachedInputTokens?: number }): { estimatedCostUsd: number; pricingSourceModel: string } | null {
  const pricing = PRICING[input.model];
  if (!pricing) return null;
  const cached = Math.max(0, Math.min(input.inputTokens, input.cachedInputTokens ?? 0));
  const uncached = Math.max(0, input.inputTokens - cached);
  const estimatedCostUsd = (uncached * pricing.inputUsdPerMillion + cached * pricing.cachedInputUsdPerMillion + input.outputTokens * pricing.outputUsdPerMillion) / 1_000_000;
  return { estimatedCostUsd, pricingSourceModel: pricing.sourceModel };
}

export function summarizeFacebookVisionUsage(visions: Array<FacebookVisionExtraction | null | undefined>, expectedCalls = visions.filter(Boolean).length): FacebookVisionCostSummary {
  const usages = visions.flatMap((vision) => vision?.usage ? [vision.usage] : []);
  const calls = Math.max(expectedCalls, usages.length);
  const exactUsages = usages.filter((usage) => usage.dataQuality === "EXACT" && usage.estimatedCostUsd !== null);
  const costedUsages = usages.filter((usage) => usage.estimatedCostUsd !== null);
  const usageUnavailableCalls = Math.max(0, calls - exactUsages.length);
  const costDataQuality: FacebookVisionCostDataQuality = calls === 0 || exactUsages.length === calls
    ? "EXACT"
    : costedUsages.length > 0 ? "PARTIAL" : "UNAVAILABLE";
  const visionCostUsd = calls === 0 ? 0 : costedUsages.length > 0
    ? costedUsages.reduce((total, usage) => total + (usage.estimatedCostUsd ?? 0), 0)
    : null;
  return {
    openaiVision: {
      calls,
      inputTokens: sumTokens(usages, "inputTokens"),
      outputTokens: sumTokens(usages, "outputTokens"),
      totalTokens: sumTokens(usages, "totalTokens"),
      cachedInputTokens: sumTokens(usages, "cachedInputTokens"),
      usageUnavailableCalls,
      models: [...new Set(usages.map((usage) => usage.model).filter(Boolean))],
    },
    visionCostUsd,
    visionCostDataQuality: costDataQuality,
    visionPricingSourceModels: [...new Set(costedUsages.map((usage) => usage.pricingSourceModel).filter((value): value is string => Boolean(value)))],
    visionPricingVersion: OPENAI_PRICING_VERSION,
  };
}

export function aggregateFacebookVisionRun(results: unknown[]): FacebookVisionRunCostSummary {
  const jobSummaries = results.flatMap((value) => {
    const row = record(value);
    const openaiVision = record(row?.openaiVision);
    if (!row || !openaiVision) return [];
    return [{ row, openaiVision }];
  });
  const calls = sumRows(jobSummaries, "calls");
  const unavailable = sumRows(jobSummaries, "usageUnavailableCalls");
  const knownCostRows = jobSummaries.filter(({ row }) => typeof row.visionCostUsd === "number");
  const costDataQuality: FacebookVisionCostDataQuality = calls === 0 || unavailable === 0
    ? "EXACT"
    : knownCostRows.length > 0 ? "PARTIAL" : "UNAVAILABLE";
  const visionCostUsd = calls === 0 ? 0 : knownCostRows.length > 0
    ? knownCostRows.reduce((total, { row }) => total + Number(row.visionCostUsd), 0)
    : null;
  const models = [...new Set(jobSummaries.flatMap(({ openaiVision }) => stringArray(openaiVision.models)))];
  const pricingModels = [...new Set(jobSummaries.flatMap(({ row }) => stringArray(row.visionPricingSourceModels)))];
  const openaiVision: FacebookOpenAIVisionSummary = {
    calls,
    inputTokens: sumRows(jobSummaries, "inputTokens"),
    outputTokens: sumRows(jobSummaries, "outputTokens"),
    totalTokens: sumRows(jobSummaries, "totalTokens"),
    cachedInputTokens: sumRows(jobSummaries, "cachedInputTokens"),
    usageUnavailableCalls: unavailable,
    models,
  };
  return {
    openaiVision,
    visionCostUsd,
    visionCostDataQuality: costDataQuality,
    visionPricingSourceModels: pricingModels,
    visionPricingVersion: OPENAI_PRICING_VERSION,
    visionCalls: calls,
    visionInputTokens: openaiVision.inputTokens,
    visionOutputTokens: openaiVision.outputTokens,
    visionTotalTokens: openaiVision.totalTokens,
    visionCachedInputTokens: openaiVision.cachedInputTokens,
    visionUsageUnavailableCalls: unavailable,
  };
}

function sumTokens(usages: FacebookVisionUsage[], field: "inputTokens" | "outputTokens" | "totalTokens" | "cachedInputTokens"): number {
  return usages.reduce((total, usage) => total + (typeof usage[field] === "number" ? usage[field] : 0), 0);
}

function sumRows(rows: Array<{ openaiVision: Record<string, unknown> }>, field: string): number {
  return rows.reduce((total, { openaiVision }) => total + (typeof openaiVision[field] === "number" ? Number(openaiVision[field]) : 0), 0);
}

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function tokenValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : []; }
