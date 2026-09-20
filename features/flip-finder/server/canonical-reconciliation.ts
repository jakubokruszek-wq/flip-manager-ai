import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CanonicalListingDecision } from "../filter-evaluation";
import { canonicalProjection } from "../canonical-projection";

export { canonicalMatchReasons, canonicalProjection } from "../canonical-projection";

type CanonicalBucket = CanonicalListingDecision["bucket"];
type MatchOrigin = "scan" | "filter_recalculation" | "collector_import";
type LifecycleStatus = "ACTIVE" | "REVIEW" | "REJECTED" | "STALE" | "ARCHIVED";
type CanonicalOperationalStatus = "ACTIVE" | "REVIEW" | "REJECTED";

export type CanonicalReconciliationInput = {
  supabase: SupabaseClient;
  listingId: string;
  filterId: string;
  decision: CanonicalListingDecision;
  lifecycleStatus?: CanonicalOperationalStatus;
  matchOrigin?: MatchOrigin;
  sourceScanId?: string | null;
  matchedAt?: string;
  signal?: AbortSignal;
};

export type CanonicalReconciliationResult = {
  listingId: string;
  searchFilterId: string;
  bucket: CanonicalBucket;
  lifecycleStatus: LifecycleStatus;
  isCurrentMatch: boolean;
  matchReasons: string[];
};

/**
 * Attached as Error.cause (never as part of the message) when the RPC call
 * fails, so a caller can recover the underlying PostgREST/Postgres fields
 * without changing what error-code parsers that key off `.message` (like
 * facebook-worker's safeErrorCode) ever see. Source-agnostic on purpose:
 * this file serves every canonical decision writer, not just Facebook.
 */
export type CanonicalReconciliationFailureDiagnostic = {
  listingId: string;
  filterId: string;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: string | null;
  errorHint: string | null;
};

/**
 * The only application entrypoint for projecting a deterministic decision into
 * listing lifecycle and filter membership. The database function locks the
 * listing and commits both writes together; GET paths never call this service.
 */
export async function reconcileCanonicalListingDecision(input: CanonicalReconciliationInput): Promise<CanonicalReconciliationResult> {
  const bucket = input.decision.bucket;
  const lifecycleStatus = input.lifecycleStatus ?? (bucket === "MATCHED" ? "ACTIVE" : bucket);
  const projection = canonicalProjection(input.decision, lifecycleStatus);
  let query = input.supabase.rpc("reconcile_canonical_listing_decision", {
    p_listing_id: input.listingId,
    p_filter_id: input.filterId,
    p_bucket: bucket,
    p_reasons: projection.matchReasons,
    p_missing_fields: projection.missingFields,
    p_lifecycle_status: projection.lifecycleStatus,
    p_match_origin: input.matchOrigin ?? "scan",
    p_source_scan_id: input.sourceScanId ?? null,
    p_matched_at: input.matchedAt ?? new Date().toISOString(),
  });
  if (input.signal) query = query.abortSignal(input.signal);
  const result = await query;
  if (result.error) {
    const diagnostic: CanonicalReconciliationFailureDiagnostic = {
      listingId: input.listingId,
      filterId: input.filterId,
      errorCode: stringOrNull(result.error.code),
      errorMessage: stringOrNull(result.error.message),
      errorDetails: stringOrNull(result.error.details),
      errorHint: stringOrNull(result.error.hint),
    };
    throw new Error(`CANONICAL_RECONCILIATION_FAILED: ${result.error.message}`, { cause: diagnostic });
  }
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row || typeof row !== "object") {
    const diagnostic: CanonicalReconciliationFailureDiagnostic = { listingId: input.listingId, filterId: input.filterId, errorCode: null, errorMessage: "missing result", errorDetails: null, errorHint: null };
    throw new Error("CANONICAL_RECONCILIATION_FAILED: missing result", { cause: diagnostic });
  }
  const value = row as Record<string, unknown>;
  return {
    listingId: String(value.listing_id ?? input.listingId),
    searchFilterId: String(value.search_filter_id ?? input.filterId),
    bucket: value.bucket === "MATCHED" || value.bucket === "REVIEW" || value.bucket === "REJECTED" ? value.bucket : bucket,
    lifecycleStatus: lifecycleValue(value.lifecycle_status) ?? projection.lifecycleStatus,
    isCurrentMatch: value.is_current_match === true,
    matchReasons: Array.isArray(value.match_reasons) ? value.match_reasons.filter((reason): reason is string => typeof reason === "string") : projection.matchReasons,
  };
}

function lifecycleValue(value: unknown): LifecycleStatus | null {
  return value === "ACTIVE" || value === "REVIEW" || value === "REJECTED" || value === "STALE" || value === "ARCHIVED" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
