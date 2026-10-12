import type { ListingSource } from "@/features/flip-finder";
import type { MarketType } from "@/features/flip-finder";
import type { RadarDetailDiagnostic } from "@/features/flip-finder/source-batches";

/** Sources with a real, direct server-side adapter -- excludes facebook (Watcher-only, never a plain HTTP fetch) and anything not yet schema-ready/active for Finder either. See source-availability.ts's SCHEMA_READY_SOURCE_IDS, the single shared source-of-truth this list is filtered from. */
export type RadarSource = Exclude<ListingSource, "facebook" | "bezposrednio" | "official_auction">;

export const DEFAULT_RADAR_DISTRICTS = ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"] as const;
export type RadarDistrict = (typeof DEFAULT_RADAR_DISTRICTS)[number];

export type RadarBuildingType = "blok" | "apartamentowiec";
export type RadarRenovationStatus = "fresh_renovation" | "turnkey_finish";
export type RadarQualityCategory = "fresh_renovation" | "ready_high_standard";
export const RADAR_QUALITY_RULES_VERSION = 2 as const;

export type RadarSourceAlternative = {
  id: string;
  source: RadarSource;
  originalUrl: string;
  title: string | null;
  price: number;
  area: number;
  rooms: number | null;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  collectedAt: string;
};

export type RadarListing = {
  id: string;
  source: RadarSource;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  price: number;
  area: number;
  pricePerSqm: number;
  rooms: number | null;
  /** Read from an explicit source field; null is not guessed from text or age. */
  yearBuilt: number | null;
  yearBuiltSourceField: "Rok budowy" | null;
  city: string;
  district: string;
  buildingType: RadarBuildingType;
  marketType: MarketType;
  renovationStatus: RadarRenovationStatus;
  /** Derived from the confirmed market and stored finish status; no DB enum change is needed. */
  qualityCategory: RadarQualityCategory;
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Source-provided dates only. Null means the portal did not provide that date. */
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  collectedAt: string;
  /** Only set when a source supplies a stable, explicit cross-portal unit reference. */
  crossSourceIdentity: string | null;
  crossSourceAlternates: RadarSourceAlternative[];
  status: "active" | "removed";
  excludedAt: string | null;
  excludedReason: string | null;
  /** A listing remains visible for review but is omitted from A/B sample statistics while unresolved. */
  verificationIssues?: string[];
};

export type RadarRunStatus = "pending" | "running" | "completed" | "failed" | "partial";
export type RadarSourceStatus = "pending" | "running" | "completed" | "failed" | "partial";

/** First strict qualification rejection reason, grouped by Radar source. */
export const RADAR_QUALIFICATION_REJECTION_REASONS = [
  "detail_not_confirmed",
  "detail_conflict",
  "listing_identity_changed",
  "price_missing",
  "area_missing",
  "price_is_not_total_offer_price",
  "price_is_starting_price",
  "price_per_sqm_invalid",
  "price_per_sqm_below_minimum",
  "area_outside_selected_range",
  "district_not_confirmed",
  "district_not_in_selected_scope",
  "city_not_lodz",
  "rental",
  "share",
  "commercial",
  "plot",
  "tenement_excluded",
  "house_excluded",
  "bulk_investment_ad",
  "apartment_not_confirmed",
  "building_type_not_confirmed",
  "market_type_not_confirmed",
  "unfinished_or_needs_renovation",
  "renovation_exclusion",
  "renovation_not_confirmed_fresh_full",
  "turnkey_not_confirmed",
  "previously_rejected_by_operator",
] as const;
export type RadarQualificationRejectionReason = (typeof RADAR_QUALIFICATION_REJECTION_REASONS)[number];
export type RadarQualificationRejections = Record<string, Partial<Record<RadarQualificationRejectionReason, number>>>;

/** Bounds frozen when a Radar run starts so a continuation issues the same portal queries. */
export type RadarSearchCriteria = {
  areaMin: number | null;
  areaMax: number | null;
  rooms: number[];
  /** Missing on legacy runs; those continue under v1 qualification rules. */
  qualityRulesVersion?: 1 | 2;
  minPricePerSqm?: number | null;
  /** Empty/missing means "no narrowing" (all 5 default districts), matching the saved-settings default. */
  districts?: string[];
};

export type RadarCheckpoint = {
  sourceQueue: RadarSource[];
  currentSourceIndex: number;
  /** Per-source adapter cursor state (page number, continuation token, ...), opaque to collect.ts itself. */
  perSourceCursor: Record<string, unknown>;
  sourceStatuses: Record<string, RadarSourceStatus>;
  sourceErrors: Record<string, string>;
  /** Non-fatal adapter notices and candidate-level rejections, separate from transport/parser failures. */
  sourceWarnings?: Record<string, string[]>;
  sourceRejectionCounts?: Record<string, Record<string, number>>;
  /** Runtime diagnostics stored in the existing checkpoint JSONB; no schema change required. */
  qualificationRejections?: RadarQualificationRejections;
  /** Optional for legacy runs; new runs persist their search bounds in the existing checkpoint JSONB. */
  searchCriteria?: RadarSearchCriteria;
  /** At most five sanitized detail examples per source; never stores page HTML or contact data. */
  detailDiagnostics?: Record<string, RadarDetailDiagnostic[]>;
  buffer: unknown[];
  bufferOffset: number;
};

export type RadarRun = {
  id: string;
  ownerId: string;
  leaseToken: string | null;
  /** Null once finished; otherwise when the current claim's lease expires -- an orphaned "running" run (e.g. a dead OLX worker) is reclaimable past this instant, not stuck forever. */
  leaseUntil: string | null;
  stopRequestedAt: string | null;
  /** Set only by the non-resumable user termination operation. */
  userTerminatedAt: string | null;
  status: RadarRunStatus;
  startedAt: string;
  finishedAt: string | null;
  checkpoint: RadarCheckpoint;
  scannedCount: number;
  qualifiedCount: number;
  errorMessage: string | null;
  sourceStatuses: Record<string, RadarSourceStatus>;
  sourceErrors: Record<string, string>;
  sourceWarnings?: Record<string, string[]>;
  sourceRejectionCounts?: Record<string, Record<string, number>>;
  qualificationRejections?: RadarQualificationRejections;
};

export type RadarMarketFilter = "secondary" | "primary" | "both";

export type RadarFilters = {
  districts: string[];
  market: RadarMarketFilter;
  areaMin: number | null;
  areaMax: number | null;
  rooms: number[];
  sources: RadarSource[];
  /** Optional display/sample filter; null means disabled. */
  minPricePerSqm: number | null;
};

export const MIN_RADAR_SAMPLE_SIZE = 20;

export type RadarStatGroup = {
  district: string;
  marketType: MarketType;
  qualityCategory: RadarQualityCategory;
  averagePricePerSqm: number | null;
  medianPricePerSqm: number | null;
  sampleSize: number;
  isSmallSample: boolean;
  updatedAt: string | null;
};

/**
 * A Radar candidate fully qualified on every OTHER criterion -- confirmed
 * building, market, and A/B finish -- with only its district left unset.
 * Separate from RadarListing/the A/B sample for as long as status is
 * "pending"; never counted in computeRadarStats() until an operator
 * assigns a district and it is promoted into price_radar_listings.
 */
export type RadarDistrictQueueItem = {
  id: string;
  source: RadarSource;
  externalListingId: string;
  originalUrl: string;
  normalizedUrl: string;
  title: string | null;
  description: string | null;
  price: number;
  area: number;
  pricePerSqm: number;
  rooms: number | null;
  city: string;
  buildingType: RadarBuildingType;
  marketType: MarketType;
  renovationStatus: RadarRenovationStatus;
  qualityCategory: RadarQualityCategory;
  firstSeenAt: string;
  lastSeenAt: string;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  collectedAt: string;
  status: "pending" | "assigned" | "rejected";
  /** A best-effort automated guess, shown as a prefilled suggestion only -- never auto-applied; the operator still chooses (or overrides) the district explicitly. */
  suggestedDistrict: string | null;
  suggestionSource: "gis" | "ai" | null;
  /** The matched sub-area name (gis) or the AI's own quoted evidence (ai), shown to the operator so a wrong guess is easy to spot. */
  suggestionEvidence: string | null;
  assignedDistrict: string | null;
  assignedAt: string | null;
  rejectedAt: string | null;
};

export type RadarVerificationFieldEvidence = Record<string, string>;
export type RadarVerificationDecision = {
  apartmentSaleConfirmed: true;
  price: number;
  area: number;
  rooms: number;
  city: "Łódź";
  district: RadarDistrict;
  buildingType: RadarBuildingType;
  marketType: MarketType;
  qualityCategory: RadarQualityCategory;
};
export type RadarVerificationQueueItem = {
  id: string;
  source: RadarSource;
  externalListingId: string;
  originalUrl: string;
  title: string | null;
  status: "pending" | "confirmed" | "rejected";
  firstSeenAt: string;
  lastSeenAt: string;
  snapshot: {
    description: string | null;
    price: number | null;
    pricePerSqm: number | null;
    area: number | null;
    rooms: number | null;
    city: string | null;
    district: string | null;
    buildingType: string | null;
    marketType: string | null;
    qualityCategory: RadarQualityCategory | null;
    publishedAt: string | null;
    sourceUpdatedAt: string | null;
    collectedAt: string | null;
    sourceHttpStatus: number | null;
    finalUrl: string | null;
    sourceIdentity: string | null;
    confirmedFields: string[];
    missingFields: string[];
    contradictoryFields: string[];
    fieldEvidence: RadarVerificationFieldEvidence;
    routingReasons: string[];
    suggestedDistrict: string | null;
    suggestionEvidence: string | null;
  };
  decision: RadarVerificationDecision | null;
  decisionAt: string | null;
  rejectedAt: string | null;
};
