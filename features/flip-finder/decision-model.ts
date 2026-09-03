export const DECISION_BUCKETS = ["MATCHED", "REVIEW", "REJECTED"] as const;
export type DecisionBucket = (typeof DECISION_BUCKETS)[number];
export type LifecycleStatus = "ACTIVE" | "REVIEW" | "STALE" | "ARCHIVED" | "REJECTED";

const REVIEWABLE_MISSING_FIELDS = new Set(["price", "area", "rooms", "buildingType", "district", "city", "floor", "topFloor", "ownership", "sellerType", "marketType"]);

export function decisionBucket(input: { reasons: string[]; unknownFields: string[] }): DecisionBucket {
  if (input.reasons.length > 0) return "REJECTED";
  return input.unknownFields.some((field) => REVIEWABLE_MISSING_FIELDS.has(field)) ? "REVIEW" : "MATCHED";
}

export function lifecycleForLastSeen(lastSeenAt: string | null | undefined, now = Date.now()): LifecycleStatus {
  if (!lastSeenAt) return "ARCHIVED";
  const timestamp = Date.parse(lastSeenAt);
  if (!Number.isFinite(timestamp)) return "ARCHIVED";
  if (now - timestamp >= 14 * 24 * 60 * 60 * 1_000) return "ARCHIVED";
  if (now - timestamp >= 7 * 24 * 60 * 60 * 1_000) return "STALE";
  return "ACTIVE";
}

export function reviewReason(unknownFields: string[]): string {
  return unknownFields.length ? `Brak danych: ${unknownFields.join(", ")}` : "Wymaga ręcznej oceny";
}
