import type { CanonicalListingDecision } from "./filter-evaluation";

export type CanonicalProjection = {
  bucket: CanonicalListingDecision["bucket"];
  lifecycleStatus: "ACTIVE" | "REVIEW" | "REJECTED";
  isCurrentMatch: boolean;
  matchReasons: string[];
  missingFields: string[];
};

/** Deterministic projection shared by write paths and consistency tests. */
export function canonicalProjection(
  decision: CanonicalListingDecision,
  lifecycleStatus?: "ACTIVE" | "REVIEW" | "REJECTED",
): CanonicalProjection {
  const bucket = decision.bucket;
  const reasons = canonicalMatchReasons(decision);
  return {
    bucket,
    lifecycleStatus: lifecycleStatus ?? (bucket === "MATCHED" ? "ACTIVE" : bucket),
    isCurrentMatch: bucket === "MATCHED",
    matchReasons: reasons,
    missingFields: bucket === "REVIEW" ? [...decision.missingFields] : [],
  };
}

export function canonicalMatchReasons(decision: CanonicalListingDecision): string[] {
  if (decision.bucket === "MATCHED") return [...decision.reasons];
  if (decision.bucket === "REVIEW") return [...new Set(["review", ...decision.reasons, ...decision.missingFields.map((field) => `unknown_${field}`)])];
  return [...decision.hardRejectReasons.length ? decision.hardRejectReasons : decision.reasons];
}
