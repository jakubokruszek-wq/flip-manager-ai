/**
 * Deterministic Facebook scan accounting.
 *
 * Every uniquely captured post is assigned exactly ONE mutually-exclusive
 * primary terminal outcome (this taxonomy), plus as many secondary reason
 * codes as genuinely apply. This is the single source of truth for
 * reconciling "N captured -> where did they go" across the whole pipeline:
 * the collector's own pre-extraction identity/freshness gate, the
 * deterministic intent/property-type/apartment-safety skips, and the
 * canonical Finder decision (MATCHED/REVIEW/REJECTED). It never re-derives
 * or second-guesses any of those decisions — it only reads their already-
 * computed result and files it into one bucket.
 *
 * STALE_POST is the one addition beyond the mission's suggested list: the
 * collector filters posts older than the freshness cutoff BEFORE extraction
 * is ever attempted (features/collector/facebook-batch-policy.ts,
 * isCollectorPostFresh), and a second, later checkpoint
 * (classifyFacebookPostAgeZone "OLD" inside importFacebookWatcher) can also
 * skip an old post that slipped past the first gate. Both represent the same
 * real-world outcome — "too old to consider" — using the same 72h threshold,
 * so they share one bucket rather than being invisible (pre-extraction) or
 * folded into the unrelated EXTRACTION_FAILED bucket (post-extraction).
 */

export const FACEBOOK_SCAN_PRIMARY_OUTCOMES = [
  "IDENTITY_UNVERIFIED",
  "STALE_POST",
  "EXTRACTION_FAILED",
  "RENTAL",
  "NON_SALE",
  "UNSUPPORTED_PROPERTY_TYPE",
  "HARD_FILTER_REJECT",
  "REVIEW",
  "MATCHED",
] as const;

export type FacebookScanPrimaryOutcome = (typeof FACEBOOK_SCAN_PRIMARY_OUTCOMES)[number];

export type FacebookPostOutcome = {
  postId: string | null;
  primaryOutcome: FacebookScanPrimaryOutcome;
  reasonCodes: string[];
};

export type FacebookScanAccounting = {
  rawCaptured: number;
  uniqueCaptured: number;
  duplicatesRemoved: number;
  byOutcome: Record<FacebookScanPrimaryOutcome, number>;
  reasonCounts: Record<string, number>;
};

function emptyOutcomeCounts(): Record<FacebookScanPrimaryOutcome, number> {
  return Object.fromEntries(FACEBOOK_SCAN_PRIMARY_OUTCOMES.map((outcome) => [outcome, 0])) as Record<FacebookScanPrimaryOutcome, number>;
}

/**
 * Classifies a post excluded by the collector's pre-extraction identity/
 * freshness gate (collectorPostsForProcessing), before extraction is ever
 * attempted. Returns null when the post is eligible to proceed — the caller
 * must then classify it further once extraction/decision results exist.
 */
export function classifyPreExtractionExclusion(input: { identityConfidence: string; identityConflict: boolean; fresh: boolean }): FacebookPostOutcome | null {
  if (input.identityConfidence !== "EXACT" || input.identityConflict) return { postId: null, primaryOutcome: "IDENTITY_UNVERIFIED", reasonCodes: ["identity_unverified"] };
  if (!input.fresh) return { postId: null, primaryOutcome: "STALE_POST", reasonCodes: ["stale_post"] };
  return null;
}

const SKIP_REASON_OUTCOME: Record<string, { primaryOutcome: FacebookScanPrimaryOutcome; reasonCode: string }> = {
  NO_REAL_ESTATE_LANGUAGE_AND_TOO_FEW_FIELDS: { primaryOutcome: "EXTRACTION_FAILED", reasonCode: "insufficient_text" },
  FACEBOOK_BUY_REQUEST: { primaryOutcome: "NON_SALE", reasonCode: "buy_request" },
  FACEBOOK_RENT_REQUEST: { primaryOutcome: "RENTAL", reasonCode: "rent_request" },
  FACEBOOK_SERVICE_POST: { primaryOutcome: "NON_SALE", reasonCode: "service_post" },
  FACEBOOK_NON_SALE_POST: { primaryOutcome: "NON_SALE", reasonCode: "non_sale_post" },
  FACEBOOK_INTENT_UNKNOWN: { primaryOutcome: "NON_SALE", reasonCode: "intent_unknown" },
  FACEBOOK_NON_APARTMENT_PROPERTY: { primaryOutcome: "UNSUPPORTED_PROPERTY_TYPE", reasonCode: "non_apartment_property" },
  FACEBOOK_STALE_POST_OLDER_THAN_72H: { primaryOutcome: "STALE_POST", reasonCode: "stale_post" },
  FACEBOOK_PROPERTY_FILTER_REJECTED: { primaryOutcome: "HARD_FILTER_REJECT", reasonCode: "property_filter_rejected" },
};

/** Maps evaluateFacebookApartmentSafety's own warning codes (carried on a FACEBOOK_PROPERTY_FILTER_REJECTED skip's warnings) to the mission's lowercase secondary-reason vocabulary. */
const APARTMENT_SAFETY_REASON_NAMES: Record<string, string> = {
  FACEBOOK_BUILDING_KAMIENICA: "kamienica",
  FACEBOOK_PROPERTY_HOUSE: "house",
  FACEBOOK_PROPERTY_PLOT: "plot",
  FACEBOOK_BUILDING_TYPE_EXCLUDED: "building_type_excluded",
  FACEBOOK_LOCATION_OUTSIDE_LODZ: "outside_lodz",
};

/**
 * Classifies a post skipped before it ever reaches the canonical Finder
 * decision — a deterministic rental/buy/service/unknown intent, an
 * unsupported (non-apartment) property type, insufficient real-estate
 * signal, or an apartment-safety hard reject (kamienica/house/plot/building
 * type/outside Łódź) or availability-not-active rejection.
 */
export function classifyFacebookSkip(input: { reasonCode: string | undefined; warnings: string[] }): FacebookPostOutcome {
  const mapped = input.reasonCode ? SKIP_REASON_OUTCOME[input.reasonCode] : undefined;
  if (!mapped) return { postId: null, primaryOutcome: "EXTRACTION_FAILED", reasonCodes: ["unclassified_skip"] };
  const apartmentSafetyReasons = input.warnings.map((warning) => APARTMENT_SAFETY_REASON_NAMES[warning]).filter((value): value is string => Boolean(value));
  const availabilityReasons = input.warnings.filter((warning) => warning.startsWith("FACEBOOK_AVAILABILITY_")).map((warning) => warning.replace("FACEBOOK_AVAILABILITY_", "").toLowerCase());
  return { postId: null, primaryOutcome: mapped.primaryOutcome, reasonCodes: [...new Set([mapped.reasonCode, ...apartmentSafetyReasons, ...availabilityReasons])] };
}

/**
 * Classifies a post that reached the canonical Finder decision. Hard-reject
 * reasons and unknown-field codes are exactly what evaluateListingAgainstFilter
 * already produced — this never re-derives or second-guesses that decision,
 * it only files it into the accounting taxonomy.
 */
export function classifyFacebookDecision(input: { bucket: "MATCHED" | "REVIEW" | "REJECTED"; reasons: string[]; unknownFields: string[] }): FacebookPostOutcome {
  if (input.bucket === "REJECTED") return { postId: null, primaryOutcome: "HARD_FILTER_REJECT", reasonCodes: [...new Set(input.reasons)] };
  if (input.bucket === "REVIEW") return { postId: null, primaryOutcome: "REVIEW", reasonCodes: [...new Set(input.unknownFields.map((field) => `unknown_${field}`))] };
  return { postId: null, primaryOutcome: "MATCHED", reasonCodes: [] };
}

/** A post whose processing threw — the one genuinely technical-failure family, distinct from a controlled skip. */
export function classifyExtractionException(reasonCode: string): FacebookPostOutcome {
  return { postId: null, primaryOutcome: "EXTRACTION_FAILED", reasonCodes: [reasonCode] };
}

/**
 * Aggregates already-classified (exactly-one-outcome-each) posts into the
 * funnel. The invariant — sum of every bucket equals uniqueCaptured — holds
 * by construction: every classifier above returns exactly one
 * primaryOutcome from the fixed taxonomy, never zero, never more than one.
 */
export function aggregateFacebookScanAccounting(outcomes: FacebookPostOutcome[], rawCaptured: number): FacebookScanAccounting {
  const byOutcome = emptyOutcomeCounts();
  const reasonCounts: Record<string, number> = {};
  for (const outcome of outcomes) {
    byOutcome[outcome.primaryOutcome] += 1;
    for (const reason of outcome.reasonCodes) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  return { rawCaptured, uniqueCaptured: outcomes.length, duplicatesRemoved: Math.max(0, rawCaptured - outcomes.length), byOutcome, reasonCounts };
}

export function verifyFacebookScanAccountingInvariant(accounting: FacebookScanAccounting): boolean {
  const sum = FACEBOOK_SCAN_PRIMARY_OUTCOMES.reduce((total, outcome) => total + accounting.byOutcome[outcome], 0);
  return sum === accounting.uniqueCaptured;
}

/** Returns the N reason codes with the highest counts, most first. */
export function topFacebookScanReasons(accounting: FacebookScanAccounting, limit = 10): Array<{ reason: string; count: number }> {
  return Object.entries(accounting.reasonCounts).map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count).slice(0, limit);
}

function pluralizeSources(count: number): string {
  if (count === 1) return "źródło zakończone w trybie degraded";
  if (count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14)) return "źródła zakończone w trybie degraded";
  return "źródeł zakończonych w trybie degraded";
}

/**
 * Turns the accounting into a concrete, human-readable Polish explanation of
 * why a scan is not "ukończony" — built entirely from the scan's own real
 * counters, never a hardcoded example. Degrades to an empty list when there
 * is no accounting to explain (a historical scan predating this feature) or
 * nothing worth calling out.
 */
export function explainPartialFacebookScan(accounting: FacebookScanAccounting | null | undefined, degradedSources = 0): string[] {
  if (!accounting) return [];
  const lines: string[] = [`${accounting.uniqueCaptured} zebranych`];
  if (accounting.byOutcome.IDENTITY_UNVERIFIED > 0) lines.push(`${accounting.byOutcome.IDENTITY_UNVERIFIED} niezweryfikowane tożsamości`);
  if (accounting.byOutcome.EXTRACTION_FAILED > 0) lines.push(`${accounting.byOutcome.EXTRACTION_FAILED} błędy ekstrakcji`);
  if (accounting.byOutcome.STALE_POST > 0) lines.push(`${accounting.byOutcome.STALE_POST} nieaktualne (starsze niż limit)`);
  if (degradedSources > 0) lines.push(`${degradedSources} ${pluralizeSources(degradedSources)}`);
  return lines;
}
