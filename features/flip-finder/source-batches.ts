import type { PropertySourceListing } from "@/features/properties/types/property";

/** A committed cursor points to the next page/site, never to a new scan. */
export type RadarDetailDiagnostic = {
  kind: "detail_fetch_failed" | "detail_identity_mismatch" | "detail_not_confirmed";
  listingUrl: string | null;
  finalUrl: string | null;
  httpStatus: number | null;
  identity: "same_url" | "same_listing_id" | "mismatch" | "unconfirmed" | "not_checked";
  unconfirmedFields: string[];
  contradictoryFields: string[];
  errorCode?: "INVALID_DETAIL_URL" | "NETWORK_ERROR" | "TIMEOUT" | "HTTP_ERROR" | "RATE_LIMITED" | "ACCESS_CHALLENGE" | "NOT_FOUND" | "GONE";
};

export type SourceBatch = {
  listings: PropertySourceListing[];
  warnings: string[];
  fetched: number;
  diagnostics?: RadarDetailDiagnostic[];
  rejectionReasons?: string[];
  /** Parser-level candidate exclusions, separate from source/transport errors. */
  sourceRejectionCounts?: Record<string, number>;
};
export type RadarDetailCursor = {
  kind: "radar_detail_v1";
  page: number;
  candidateIndex: number;
  /** One persisted retry for a 429; no request is sent before this instant. */
  retryAfterUntil?: string;
  retryAttempt?: number;
};
export type SourceBatchCursor = number | RadarDetailCursor | null;
export type SourceBatchYieldReason = "portion_budget" | "detail_batch_limit" | "detail_rate_limit";

/** A completed, persisted batch may deliberately yield while retaining its opaque cursor. */
export class SourceBatchYield extends Error {
  readonly reason: SourceBatchYieldReason;

  constructor(reason: SourceBatchYieldReason) {
    super(`SOURCE_BATCH_YIELD:${reason}`);
    this.name = "SourceBatchYield";
    this.reason = reason;
  }
}

export type SourceBatchContext = {
  cursor?: number;
  /** Present only while the selected Radar run is enriching a portal detail page. */
  radarDetailCursor?: RadarDetailCursor;
  purpose?: "finder" | "price_radar";
  /** Preserve the search-page identity of Radar checkpoints created before the Oferty.net form query. */
  ofertyNetLegacySearch?: boolean;
  /** Hard yield boundary supplied by the owning Radar portion. */
  deadlineAt?: number;
  /**
   * Radar only: soft per-source time slice. After at least one detail page in
   * this attempt, no new detail request starts past this instant (replaces the
   * fixed three-details-per-portion cap when present).
   */
  sliceDeadlineAt?: number;
  /** Radar only: time reserved for one detail request before `deadlineAt` (defaults to its timeout). */
  detailReserveMs?: number;
  /** Radar only: profiling hook, called once per HTTP request with its duration. */
  onRequest?(kind: "list" | "detail" | "context", durationMs: number): void;
  /**
   * Radar only: true when this offer (`source:externalListingId`) was already
   * committed in the same run. The owner records it only when the batch
   * containing it is committed, never before.
   */
  isDetailChecked?(key: string): boolean;
  /**
   * Radar only: result/context pages already read in the SAME portion (at most
   * one portion, < 60 s old), so taking a portal up again after its time slice
   * does not re-read the same result page.
   */
  pageCache?: Map<string, { html: string; finalUrl: string }>;
  /**
   * Radar only: small values derived from stable portal context (for example
   * Oferty.net's city location IDs), kept by the run for a limited time.
   */
  contextValues?: { get(key: string): string | undefined; set(key: string, value: string): void };
  onBatch(batch: SourceBatch, nextCursor: SourceBatchCursor): Promise<void>;
};
