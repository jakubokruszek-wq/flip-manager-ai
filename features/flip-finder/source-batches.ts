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
  errorCode?: "INVALID_DETAIL_URL" | "NETWORK_ERROR" | "TIMEOUT" | "HTTP_ERROR" | "ACCESS_CHALLENGE" | "NOT_FOUND" | "GONE";
};

export type SourceBatch = { listings: PropertySourceListing[]; warnings: string[]; fetched: number; diagnostics?: RadarDetailDiagnostic[]; rejectionReasons?: string[] };
export type RadarDetailCursor = {
  kind: "radar_detail_v1";
  page: number;
  candidateIndex: number;
};
export type SourceBatchCursor = number | RadarDetailCursor | null;
export type SourceBatchYieldReason = "portion_budget" | "detail_batch_limit";

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
  onBatch(batch: SourceBatch, nextCursor: SourceBatchCursor): Promise<void>;
};
