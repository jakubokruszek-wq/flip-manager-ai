export const FACEBOOK_HIGH_PRIORITY_SCORE = 85;
export const FACEBOOK_PRIVATE_RENOVATION_MIN_SCORE = 65;

export type FacebookListingPriorityInput = {
  opportunityScore: number;
  flipScore: number;
  priceSuspect: boolean;
  sellerType: "private" | "agency" | null;
  condition: "renovation" | "ready" | null;
  listingIntent: string | null;
  decisionBucket: "MATCHED" | "REVIEW" | "REJECTED";
  lifecycleStatus: string | null;
};

/**
 * High priority is a presentation signal for an actionable sale, not a
 * replacement for the filter decision. Rejected, stale and archived rows can
 * remain in the Watcher history, but they must never receive this badge.
 */
export function isHighPriorityFacebookListing(input: FacebookListingPriorityInput): boolean {
  if (input.listingIntent !== "SELL_PROPERTY") return false;
  if (input.priceSuspect) return false;
  if (input.decisionBucket === "REJECTED" || ["REJECTED", "STALE", "ARCHIVED"].includes(input.lifecycleStatus ?? "")) return false;

  const score = Math.max(input.opportunityScore, input.flipScore);
  return score >= FACEBOOK_HIGH_PRIORITY_SCORE
    || (input.sellerType === "private" && input.condition === "renovation" && score >= FACEBOOK_PRIVATE_RENOVATION_MIN_SCORE);
}
