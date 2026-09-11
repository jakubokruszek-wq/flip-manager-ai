import type { EvidenceClass, ProvenanceEntry } from "./types";

export type ConflictStatus = "NONE" | "CRITICAL";
export type FreshnessStatus = "CURRENT" | "STALE" | "UNKNOWN";
export type EffectiveFact<T> = {
  field: string;
  effectiveValue: T | null;
  sourceValue: T | null;
  overrideValue: T | null;
  provenance: ProvenanceEntry["provenance"];
  sourceEvidenceIds: string[];
  conflictStatus: ConflictStatus;
  freshness: FreshnessStatus;
  resolutionReason: string;
  classification: EvidenceClass;
  confidence: number;
  source: string;
  observedAt: string | null;
  evidenceId: string | null;
  assumptionId: string | null;
};

export function resolveEffectiveFact<T>(input: {
  field: string;
  sourceValue: T | null;
  sourceEvidenceIds?: string[];
  sourceProvenance?: ProvenanceEntry["provenance"];
  sourceClassification?: EvidenceClass;
  sourceName?: string;
  sourceObservedAt?: string | null;
  overrideValue?: T | null;
  overrideEvidenceId?: string | null;
  now?: string;
  maxAgeDays?: number;
  equals?: (left: T, right: T) => boolean;
}): EffectiveFact<T> {
  const sourceIds = [...new Set((input.sourceEvidenceIds ?? []).filter(Boolean))];
  const hasOverride = input.overrideValue !== undefined && input.overrideValue !== null;
  const conflict = hasOverride && input.sourceValue !== null && !(input.equals ?? Object.is)(input.sourceValue, input.overrideValue!);
  const effectiveValue = hasOverride ? input.overrideValue! : input.sourceValue;
  const sourceObservedAt = input.sourceObservedAt ?? null;
  const freshness = freshnessOf(sourceObservedAt, input.now, input.maxAgeDays ?? 90);
  const evidenceId = effectiveValue === null ? null : hasOverride ? input.overrideEvidenceId ?? `override:${input.field}` : sourceIds[0] ?? `source:${input.field}`;
  return {
    field: input.field,
    effectiveValue,
    sourceValue: input.sourceValue,
    overrideValue: hasOverride ? input.overrideValue! : null,
    provenance: hasOverride ? "MANUAL_OVERRIDE" : input.sourceProvenance ?? (effectiveValue === null ? "UNKNOWN" : "EXTRACTED"),
    sourceEvidenceIds: sourceIds,
    conflictStatus: conflict ? "CRITICAL" : "NONE",
    freshness,
    resolutionReason: conflict ? "MANUAL_OVERRIDE_DESPITE_CONFLICT_REQUIRED" : hasOverride ? "MANUAL_OVERRIDE_SELECTED" : effectiveValue === null ? "NO_SOURCE_VALUE" : "SOURCE_VALUE_SELECTED",
    classification: hasOverride ? "USER_OVERRIDE" : input.sourceClassification ?? (effectiveValue === null ? "UNKNOWN" : "FACT"),
    confidence: effectiveValue === null ? 0 : conflict ? 35 : hasOverride ? 100 : 90,
    source: hasOverride ? "DEAL_FACT_OVERRIDE" : input.sourceName ?? "LISTING",
    observedAt: sourceObservedAt,
    evidenceId,
    assumptionId: null,
  };
}

function freshnessOf(observedAt: string | null, now: string | undefined, maxAgeDays: number): FreshnessStatus {
  if (!observedAt || !now || !Number.isFinite(Date.parse(observedAt)) || !Number.isFinite(Date.parse(now))) return "UNKNOWN";
  return Date.parse(now) - Date.parse(observedAt) <= maxAgeDays * 86_400_000 ? "CURRENT" : "STALE";
}

export function confirmOverrideDespiteConflict(input: { userId: string; reason: string; timestamp: string }): { userId: string; reason: string; timestamp: string } {
  if (!input.userId.trim() || !input.reason.trim() || !Number.isFinite(Date.parse(input.timestamp))) throw new Error("OVERRIDE_CONFIRMATION_INVALID");
  return { userId: input.userId.trim(), reason: input.reason.trim().slice(0, 500), timestamp: input.timestamp };
}
