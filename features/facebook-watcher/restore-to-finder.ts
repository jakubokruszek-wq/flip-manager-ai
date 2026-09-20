import { evaluateCanonicalListingDecision, type FilterCandidate, type FilterDecision } from "../flip-finder/filter-evaluation.ts";
import type { SearchFilter } from "../flip-finder/index.ts";

export type FacebookRestoreBucket = "MATCHED" | "REVIEW" | "REJECTED";
export function classifyFacebookRestore(candidate: FilterCandidate, filters: SearchFilter[]): { bucket: FacebookRestoreBucket; decision: FilterDecision | null; filter: SearchFilter | null } {
  let review: { decision: FilterDecision; filter: SearchFilter } | null = null;
  let rejected: { decision: FilterDecision; filter: SearchFilter } | null = null;
  for (const filter of filters) {
    const canonical = evaluateCanonicalListingDecision(candidate, filter);
    const decision: FilterDecision = { matches: canonical.bucket === "MATCHED", bucket: canonical.bucket, reasons: canonical.reasons, unknownFields: canonical.missingFields, missingFields: canonical.missingFields };
    if (canonical.bucket === "MATCHED") return { bucket: "MATCHED", decision, filter };
    if (canonical.bucket === "REVIEW" && !review) review = { decision, filter };
    if (canonical.bucket === "REJECTED" && !rejected) rejected = { decision, filter };
  }
  if (review) return { bucket: "REVIEW", decision: review.decision, filter: review.filter };
  return rejected ? { bucket: "REJECTED", decision: rejected.decision, filter: rejected.filter } : { bucket: "REJECTED", decision: null, filter: null };
}
