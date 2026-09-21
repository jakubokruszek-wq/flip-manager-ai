export const ALERT_TYPES = ["facebook_opportunity", "high_flip_score", "price_drop", "private_seller", "new_listing", "canonical_match"] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/**
 * new_listing is purely informational ("something new appeared, worth a
 * look") and is the only alert type without its own attractiveness/urgency
 * signal (score threshold, price drop, canonical match). Every other type
 * already gates on a real, existing signal before it is ever created (see
 * createAlertsForListing in alert-rules.ts), so it is safe to push
 * immediately. This is the single source of truth for that split — never
 * re-list the alert types elsewhere.
 */
const PUSH_ELIGIBLE_ALERT_TYPES = new Set<AlertType>(["canonical_match", "facebook_opportunity", "high_flip_score", "private_seller", "price_drop"]);
export function isPushEligibleAlertType(type: AlertType): boolean {
  return PUSH_ELIGIBLE_ALERT_TYPES.has(type);
}

export type InvestmentAlert = {
  id: string;
  eventKey: string;
  type: AlertType;
  listingId: string;
  title: string;
  source: string;
  sellerType: string | null;
  price: number | null;
  area: number | null;
  neighborhood: string | null;
  city: string | null;
  pricePerSqm: number | null;
  flipScore: number | null;
  opportunityScore: number | null;
  condition: string | null;
  groupName: string | null;
  flags: string[];
  detectedAt: string;
  readAt: string | null;
  detailsUrl: string;
  originalUrl: string | null;
};

export type AlertPreferences = {
  minFlipScore: number;
  minOpportunityScore: number;
  privateOnly: boolean;
  facebookOnly: boolean;
  lodzOnly: boolean;
  renovationOnly: boolean;
  priceDrops: boolean;
  neighborhoods: string[];
  maxPrice: number | null;
  maxPricePerSqm: number | null;
};

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { minFlipScore: 85, minOpportunityScore: 85, privateOnly: false, facebookOnly: false, lodzOnly: false, renovationOnly: false, priceDrops: true, neighborhoods: [], maxPrice: null, maxPricePerSqm: null };
