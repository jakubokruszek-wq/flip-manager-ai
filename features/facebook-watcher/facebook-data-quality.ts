import { FACEBOOK_CONFIDENCE_FIELDS, type FacebookConfidenceField, type FacebookFieldConfidence } from "../facebook-worker/types.ts";
import type { FacebookProperty } from "./types";

const MIN_ACCEPTED_CONFIDENCE = 0.7;
const MIN_PRICE_CONFIDENCE = 0.75;

export type ExistingFacebookQuality = {
  values: { [K in FacebookConfidenceField]?: FacebookProperty[K] | null };
  confidence: number;
  fieldConfidence?: FacebookFieldConfidence;
};

export type FacebookQualityMerge = {
  property: FacebookProperty;
  fieldConfidence: FacebookFieldConfidence;
  priceChanged: boolean;
};

export function mergeFacebookPropertyByConfidence(
  existing: ExistingFacebookQuality | null,
  incoming: FacebookProperty,
): FacebookQualityMerge {
  if (!existing) {
    return {
      property: incoming,
      fieldConfidence: confidenceMap(incoming, incoming.confidence, incoming.fieldConfidence),
      priceChanged: false,
    };
  }

  const property = { ...incoming };
  const fieldConfidence: FacebookFieldConfidence = {};
  let priceChanged = false;

  for (const field of FACEBOOK_CONFIDENCE_FIELDS) {
    const oldValue = existing.values[field];
    const newValue = incoming[field];
    const oldConfidence = fieldScore(field, oldValue, existing.confidence, existing.fieldConfidence);
    const newConfidence = fieldScore(field, newValue, incoming.confidence, incoming.fieldConfidence);

    if (isMissing(newValue) && !isMissing(oldValue)) {
      assign(property, field, oldValue);
      fieldConfidence[field] = oldConfidence;
      continue;
    }
    if (isMissing(oldValue)) {
      if (!isMissing(newValue) && newConfidence < minimumConfidence(field)) assign(property, field, oldValue);
      fieldConfidence[field] = isMissing(property[field]) ? oldConfidence : newConfidence;
      continue;
    }
    if (sameValue(oldValue, newValue)) {
      assign(property, field, oldValue);
      fieldConfidence[field] = Math.max(oldConfidence, newConfidence);
      continue;
    }

    const confidenceAllowsUpdate = newConfidence >= minimumConfidence(field) && newConfidence >= oldConfidence;
    const safePrice = field !== "price" || !looksLikeOcrDigitLoss(oldValue, newValue);
    if (!confidenceAllowsUpdate || !safePrice) {
      assign(property, field, oldValue);
      fieldConfidence[field] = oldConfidence;
      continue;
    }

    fieldConfidence[field] = newConfidence;
    if (field === "price") priceChanged = true;
  }

  property.fieldConfidence = fieldConfidence;
  property.confidence = Math.max(existing.confidence, incoming.confidence);
  return { property, fieldConfidence, priceChanged };
}

export function parseFacebookFieldConfidence(value: unknown): FacebookFieldConfidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const result: FacebookFieldConfidence = {};
  for (const field of FACEBOOK_CONFIDENCE_FIELDS) {
    if (typeof row[field] === "number" && Number.isFinite(row[field])) result[field] = clamp(row[field]);
  }
  return Object.keys(result).length ? result : undefined;
}

export function facebookNoMatchWarnings(matches: boolean, reasons: string[]): string[] {
  if (matches) return [];
  const reasonCodes = reasons.filter((reason) => /^[a-z0-9_]+$/.test(reason));
  return [`FACEBOOK_NO_MATCH:${reasonCodes.length > 0 ? reasonCodes.join(",") : "unknown"}`];
}

function confidenceMap(property: FacebookProperty, fallback: number, provided?: FacebookFieldConfidence): FacebookFieldConfidence {
  return Object.fromEntries(FACEBOOK_CONFIDENCE_FIELDS.map((field) => [field, fieldScore(field, property[field], fallback, provided)])) as FacebookFieldConfidence;
}

function fieldScore(field: FacebookConfidenceField, value: unknown, fallback: number, provided?: FacebookFieldConfidence): number {
  if (isMissing(value)) return 0;
  return clamp(provided?.[field] ?? fallback);
}

function minimumConfidence(field: FacebookConfidenceField): number {
  return field === "price" ? MIN_PRICE_CONFIDENCE : MIN_ACCEPTED_CONFIDENCE;
}

function looksLikeOcrDigitLoss(previous: unknown, next: unknown): boolean {
  if (typeof previous !== "number" || typeof next !== "number" || next >= previous) return false;
  const previousDigits = String(Math.round(previous));
  const nextDigits = String(Math.round(next));
  return previousDigits.length === nextDigits.length + 1 && previousDigits.includes(nextDigits);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left === "string" && typeof right === "string") return left.trim().toLocaleLowerCase("pl-PL") === right.trim().toLocaleLowerCase("pl-PL");
  return left === right;
}

function isMissing(value: unknown): value is null | undefined | "" {
  return value === null || value === undefined || value === "";
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)); }

function assign<K extends FacebookConfidenceField>(target: FacebookProperty, field: K, value: FacebookProperty[K] | undefined): void {
  target[field] = (value ?? null) as FacebookProperty[K];
}
