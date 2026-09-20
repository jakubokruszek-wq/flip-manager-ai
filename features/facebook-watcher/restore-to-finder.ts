import { evaluateListingAgainstFilter, type FilterCandidate, type FilterDecision } from "../flip-finder/filter-evaluation.ts";
import type { SearchFilter } from "../flip-finder/index.ts";

export type FacebookRestoreBucket = "MATCHED" | "REVIEW" | "REJECTED";
export function classifyFacebookRestore(candidate: FilterCandidate, filters: SearchFilter[]): { bucket: FacebookRestoreBucket; decision: FilterDecision | null; filter: SearchFilter | null } {
  let review: { decision: FilterDecision; filter: SearchFilter } | null = null;
  for (const filter of filters) {
    const decision = evaluateListingAgainstFilter(candidate, filter);
    if (decision.bucket === "MATCHED") return { bucket: "MATCHED", decision, filter };
    if (decision.bucket === "REVIEW" && !review) review = { decision, filter };
  }
  return review ? { bucket: "REVIEW", decision: review.decision, filter: review.filter } : { bucket: "REJECTED", decision: null, filter: null };
}
