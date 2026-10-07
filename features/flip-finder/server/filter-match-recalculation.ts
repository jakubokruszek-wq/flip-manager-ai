import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
  planFilterMatchRecalculation,
  type RecalculationListing,
  type RecalculationMatch,
} from "@/features/flip-finder/filter-match-recalculation-plan";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  canReconcileNegativeResults,
  membershipAuditEntry,
  reconciliationMembershipState,
  visibleMembership,
  type MembershipAuditEntry,
} from "@/features/flip-finder/membership-reconciliation";
import { canonicalMatchReasons, reconcileCanonicalListingDecision } from "./canonical-reconciliation";
import { MIN_TOTAL_SALE_PRICE_PLN } from "@/features/flip-finder/sale-price-policy";
import { isListingSource as isKnownListingSource } from "@/features/flip-finder/search-filter-contract";

type Row = Record<string, unknown>;

export type FilterRecalculationResult = {
  evaluated: number;
  matchesBefore: number;
  addedMatches: number;
  removedMatches: number;
  unchangedMatches: number;
  /** Listings recovered from a non-visible prior state (e.g. wrongly marked listing_missing) back into REVIEW. See planFilterMatchRecalculation's recoveredReviewListingIds doc comment. */
  recoveredReviewMatches: number;
  /** Stale listing_missing rows replaced with a current, concrete rejection. */
  recoveredRejectedMatches: number;
  matchesAfter: number;
  rejectedByPricePerSqm: number;
  rejectedByOtherCriteria: number;
  maxPricePerSqmBefore: number | null;
  maxPricePerSqmAfter: number | null;
  reconciliationAllowed: boolean;
  reconciliationReason: string;
};

export type FilterRecalculationOptions = {
  /** Explicit filter edits/admin recalculations may run without a scan. */
  allowWithoutScan?: boolean;
  scanRunId?: string | null;
  /**
   * Restricts which of the filter's own sources this pass re-evaluates —
   * used by Finder's Facebook path, which must reconcile only the
   * already-collected Facebook listings and never touch sources a live scan
   * just finished handling in the same request. Defaults to every source
   * the filter itself declares.
   */
  sourcesOverride?: SearchFilter["sources"];
};

export async function recalculateFilterMatches(
  searchFilterId: string,
  options: FilterRecalculationOptions = {},
): Promise<FilterRecalculationResult | null> {
  const reconciliationStartedAt = new Date().toISOString();
  const filter = await getSearchFilter(searchFilterId);

  if (!filter) {
    return null;
  }

  // reconcileCanonicalListingDecision (called below) writes through a
  // service_role-only RPC by design — see the grant migration. This whole
  // function is trusted server code, so it must use the admin client, not
  // the anon/publishable one, which has been explicitly revoked from that
  // RPC and fails every call with "permission denied for function
  // reconcile_canonical_listing_decision" (CANONICAL_RECONCILIATION_FAILED).
  const supabase = createAdminClient();
  const matches = await fetchMatches(supabase, searchFilterId);
  const reconciliation = await readReconciliationDecision(supabase, searchFilterId, options);
  if (!reconciliation.allowed) {
    return blockedResult(matches.filter((match) => visibleMembership({ isCurrentMatch: match.isCurrentMatch !== false, matchReasons: match.matchReasons ?? [] })).length, reconciliation.reason);
  }

  const listings = await fetchListingsForSources(supabase, options.sourcesOverride ?? filter.sources);
  // Deliberately unscoped by sourcesOverride: an existing match for a source
  // outside the override (e.g. an already-matched Otodom listing, when this
  // call is scoped to ["facebook"]) must still be fetched by id here so the
  // plan can see it and correctly leave it "unchanged" — never fall through
  // to the plan's removed-if-missing fallback just because this pass wasn't
  // asked to re-scan that source.
  const missingMatchedIds = matches
    .map((match) => match.listingId)
    .filter((listingId) => !listings.some((listing) => listing.id === listingId));
  const missingMatchedListings = await fetchListingsByIds(supabase, missingMatchedIds);
  const combinedListings = await hydrateFacebookListingIntents(supabase, [...listings, ...missingMatchedListings]);
  const plan = planFilterMatchRecalculation(filter, combinedListings, matches);

  const inactiveDecisionIds = [...plan.removedListingIds, ...plan.recoveredRejectedListingIds];
  if (inactiveDecisionIds.length > 0) {
    const removedDecisions = new Map([
      ...plan.removedListingDecisions,
      ...plan.recoveredRejectedDecisions,
    ].map((entry) => [entry.listingId, entry]));
    // The real, fresh reason this listing no longer matches -- never the old
    // generic "reconciled_out"/"complete_scan_filter_mismatch" pair, which
    // told an operator nothing and, worse, collapsed a genuine REVIEW
    // (missing data, legitimately zero reject reasons) into a REJECTED.
    // Falling back to that generic pair only when the plan has NO decision
    // at all for this id (must not happen, but must never crash a save over
    // it) -- not merely when its real reasons happen to be an empty array,
    // which is the normal, correct shape of a REVIEW decision.
    const resolveDecision = (listingId: string) => {
      const removed = removedDecisions.get(listingId);
      const bucket = removed?.bucket ?? "REJECTED";
      const reasons = removed ? removed.reasons : ["reconciled_out", "complete_scan_filter_mismatch"];
      const missingFields = removed?.missingFields ?? [];
      return { bucket, reasons, missingFields };
    };
    // A REVIEW-bucket listing (missing data) never lands in unchangedListingIds
    // -- it is not a MATCHED decision -- so without this check it would be
    // re-written on every single recalculation forever, even when nothing
    // about it changed. Comparing against the exact projected match_reasons
    // a real write would produce is what makes a repeated save genuinely
    // idempotent (no audit row, no canonical RPC call) rather than merely
    // "producing the same end state via a redundant write every time".
    const listingsNeedingWrite = inactiveDecisionIds.filter((listingId) => {
      const { bucket, reasons, missingFields } = resolveDecision(listingId);
      const prospectiveReasons = canonicalMatchReasons({ bucket, reasons, missingFields, hardRejectReasons: bucket === "REJECTED" ? reasons : [] });
      const previous = matches.find((match) => match.listingId === listingId);
      const alreadyCorrect = previous?.isCurrentMatch === false && sameReasons(previous.matchReasons ?? [], prospectiveReasons);
      return !alreadyCorrect;
    });

    if (listingsNeedingWrite.length > 0) {
      const auditRows = listingsNeedingWrite.map((listingId) => {
        const previous = matches.find((match) => match.listingId === listingId);
        return membershipAuditEntry({
          filterId: searchFilterId,
          listingId,
          previousState: previous ? reconciliationMembershipState(previous.isCurrentMatch === true, previous.matchReasons ?? []) : "NONE",
          newState: "INACTIVE",
          reason: "COMPLETE_SCAN_FILTER_MISMATCH",
          scanRunId: options.scanRunId ?? null,
        });
      });
      await writeMembershipAudit(supabase, auditRows);
      for (const listingId of listingsNeedingWrite) {
        const { bucket, reasons, missingFields } = resolveDecision(listingId);
        await reconcileCanonicalListingDecision({
          supabase,
          listingId,
          filterId: searchFilterId,
          decision: { bucket, reasons, missingFields, hardRejectReasons: bucket === "REJECTED" ? reasons : [] },
          matchOrigin: "filter_recalculation",
          matchedAt: reconciliationStartedAt,
        });
      }
    }
  }

  if (plan.addedListingIds.length > 0) {
    const auditRows = plan.addedListingIds.map((listingId) => {
      const previous = matches.find((match) => match.listingId === listingId);
      return membershipAuditEntry({
        filterId: searchFilterId,
        listingId,
        previousState: previous ? reconciliationMembershipState(previous.isCurrentMatch === true, previous.matchReasons ?? []) : "NONE",
        newState: "MATCHED",
        reason: "COMPLETE_SCAN_FILTER_MATCH",
        scanRunId: options.scanRunId ?? null,
      });
    });
    await writeMembershipAudit(supabase, auditRows);
    for (const listingId of plan.addedListingIds) {
      await reconcileCanonicalListingDecision({
        supabase,
        listingId,
        filterId: searchFilterId,
        decision: { bucket: "MATCHED", reasons: ["filter_recalculation"], missingFields: [], hardRejectReasons: [] },
        lifecycleStatus: "ACTIVE",
        matchOrigin: "filter_recalculation",
        matchedAt: reconciliationStartedAt,
      });
    }
  }

  // A listing stuck in a non-visible prior state (e.g. wrongly marked
  // listing_missing by a since-fixed source-allowlist bug) whose fresh
  // evaluation is genuinely REVIEW-eligible: recover it the same way a live
  // scan would, instead of leaving it invisible forever. See
  // planFilterMatchRecalculation's recoveredReviewListingIds doc comment for
  // why this never fabricates a brand-new match from nothing.
  if (plan.recoveredReviewListingIds.length > 0) {
    const decisionsById = new Map(plan.recoveredReviewDecisions.map((entry) => [entry.listingId, entry]));
    const auditRows = plan.recoveredReviewListingIds.map((listingId) => {
      const previous = matches.find((match) => match.listingId === listingId);
      return membershipAuditEntry({
        filterId: searchFilterId,
        listingId,
        previousState: previous ? reconciliationMembershipState(previous.isCurrentMatch === true, previous.matchReasons ?? []) : "NONE",
        newState: "REVIEW",
        reason: "COMPLETE_SCAN_FILTER_REVIEW_RECOVERED",
        scanRunId: options.scanRunId ?? null,
      });
    });
    await writeMembershipAudit(supabase, auditRows);
    for (const listingId of plan.recoveredReviewListingIds) {
      const decision = decisionsById.get(listingId);
      await reconcileCanonicalListingDecision({
        supabase,
        listingId,
        filterId: searchFilterId,
        decision: { bucket: "REVIEW", reasons: decision?.reasons ?? [], missingFields: decision?.missingFields ?? [], hardRejectReasons: [] },
        matchOrigin: "filter_recalculation",
        matchedAt: reconciliationStartedAt,
      });
    }
  }

  return {
    evaluated: plan.evaluated,
    matchesBefore: plan.matchesBefore,
    addedMatches: plan.addedListingIds.length,
    removedMatches: plan.removedListingIds.length,
    unchangedMatches: plan.unchangedListingIds.length,
    recoveredReviewMatches: plan.recoveredReviewListingIds.length,
    recoveredRejectedMatches: plan.recoveredRejectedListingIds.length,
    matchesAfter: plan.matchesAfter,
    rejectedByPricePerSqm: plan.rejectedByPricePerSqm,
    rejectedByOtherCriteria: plan.rejectedByOtherCriteria,
    maxPricePerSqmBefore: plan.maxPricePerSqmBefore,
    maxPricePerSqmAfter: plan.maxPricePerSqmAfter,
    reconciliationAllowed: true,
    reconciliationReason: reconciliation.reason,
  };
}

async function readReconciliationDecision(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  searchFilterId: string,
  options: FilterRecalculationOptions,
) {
  if (options.allowWithoutScan) {
    return { allowed: true, reason: "EXPLICIT_MANUAL_RECALCULATION" as const };
  }

  const latest = await supabase
    .from("source_scans")
    .select("status,finished_at,error_message")
    .eq("search_filter_id", searchFilterId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw new Error("Nie udało się sprawdzić kompletności ostatniego skanu.");
  if (!latest.data) return { allowed: false, reason: "SCAN_NOT_FINISHED" as const };
  return canReconcileNegativeResults({ status: stringValue(latest.data.status), finishedAt: stringValue(latest.data.finished_at), errorMessage: stringValue(latest.data.error_message) });
}

function blockedResult(matchesBefore: number, reason: string): FilterRecalculationResult {
  return {
    evaluated: 0,
    matchesBefore,
    addedMatches: 0,
    removedMatches: 0,
    unchangedMatches: matchesBefore,
    recoveredReviewMatches: 0,
    recoveredRejectedMatches: 0,
    matchesAfter: matchesBefore,
    rejectedByPricePerSqm: 0,
    rejectedByOtherCriteria: 0,
    maxPricePerSqmBefore: null,
    maxPricePerSqmAfter: null,
    reconciliationAllowed: false,
    reconciliationReason: reason,
  };
}

async function writeMembershipAudit(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  entries: MembershipAuditEntry[],
): Promise<void> {
  if (!entries.length) return;
  const { error } = await supabase.from("listing_filter_match_audit").insert(entries.map((entry) => ({
    search_filter_id: entry.filterId,
    listing_id: entry.listingId,
    previous_state: entry.previousState,
    new_state: entry.newState,
    reason: entry.reason,
    scan_run_id: entry.scanRunId,
    created_at: entry.timestamp,
  })));
  if (error) {
    // Reconciliation is deliberately fail-safe: without the forward audit
    // ledger we must not mutate memberships, even when the table has not yet
    // been applied in an environment.
    if (isMissingAuditTable(error)) {
      throw new Error("Nie można bezpiecznie przeliczyć członkostwa bez audytu zmian.");
    }
    throw new Error("Nie udało się zapisać audytu członkostwa filtra.");
  }
}

async function fetchListingsForSources(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  sources: SearchFilter["sources"],
): Promise<RecalculationListing[]> {
  const rows: Row[] = [];
  const pageSize = 500;

  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabase
      .from("listings")
      .select("id,source,original_url,title,description,price,area,price_per_sqm,rooms,floor,city,district,address,building_type,ownership,manual_decision,lifecycle_status")
      .in("source", sources)
      .range(start, start + pageSize - 1);

    if (error) {
      throw new Error("Nie udało się pobrać ofert do przeliczenia.");
    }

    const page = asRows(data);
    rows.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return rows.map(toListing).filter((listing): listing is RecalculationListing => listing !== null);
}

async function fetchMatches(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  filterId: string,
): Promise<RecalculationMatch[]> {
  // Same silent-truncation risk as getFilterResults (filter-results.ts): an
  // unranged select caps at Supabase/PostgREST's default row limit (confirmed
  // empirically: exactly 1000). A filter this size has 2000+
  // listing_filter_matches rows -- without pagination, planFilterMatchRecalculation
  // only ever sees whichever ~1000 happened to come back, understating
  // existingIds/matchesBefore and skipping real recovery/reconciliation for
  // every match outside that slice. search_filter_id is already fixed by the
  // .eq() below, so listing_id alone is a stable, unique total order for
  // .range() to page across.
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabase
      .from("listing_filter_matches")
      .select("listing_id,is_current_match,match_reasons")
      .eq("search_filter_id", filterId)
      .order("listing_id", { ascending: true })
      .range(start, start + pageSize - 1);

    if (error) {
      throw new Error("Nie udało się pobrać istniejących dopasowań.");
    }

    const page = asRows(data);
    rows.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return rows.flatMap((row) => {
    const listingId = nullableString(row.listing_id);
    return listingId
      ? [{ listingId, isCurrentMatch: row.is_current_match !== false, matchReasons: stringArray(row.match_reasons) }]
      : [];
  });
}

async function fetchListingsByIds(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  ids: string[],
): Promise<RecalculationListing[]> {
  if (ids.length === 0) {
    return [];
  }

  // Same unranged-select truncation risk as fetchMatches above -- id is this
  // table's own primary key, a stable, unique total order for .range().
  // Also chunks the id list itself: confirmed empirically that an .in("id",
  // [...]) filter with ~400+ UUIDs produces a GET request whose query
  // string exceeds PostgREST's ~16KB HTTP header limit and fails outright
  // (HeadersOverflowError), not a truncation -- a hard failure regardless of
  // key. ids here is normally small (only listings matched under a source
  // this pass's sourcesOverride excludes), but must not silently break if it
  // ever grows past that boundary.
  const idChunkSize = 200;
  const rows: Row[] = [];
  for (let idStart = 0; idStart < ids.length; idStart += idChunkSize) {
    const idChunk = ids.slice(idStart, idStart + idChunkSize);
    const pageSize = 1000;
    for (let start = 0; ; start += pageSize) {
      const { data, error } = await supabase
        .from("listings")
        .select("id,source,original_url,title,description,price,area,price_per_sqm,rooms,floor,city,district,address,building_type,ownership,manual_decision,lifecycle_status")
        .in("id", idChunk)
        .order("id", { ascending: true })
        .range(start, start + pageSize - 1);

      if (error) {
        throw new Error("Nie udało się pobrać obecnych wyników do przeliczenia.");
      }

      const page = asRows(data);
      rows.push(...page);

      if (page.length < pageSize) {
        break;
      }
    }
  }

  return rows.map(toListing).filter((listing): listing is RecalculationListing => listing !== null);
}

async function hydrateFacebookListingIntents(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  listings: RecalculationListing[],
): Promise<RecalculationListing[]> {
  // Keep the normal non-Facebook and healthy Facebook recalculation path
  // limited to its existing tables. Only rows that could otherwise be shown
  // with an unsafe price/unknown sale intent need the sidecar metadata lookup.
  const facebookIds = [...new Set(listings
    .filter((listing) => listing.source === "facebook" && (listing.price === null || listing.price < MIN_TOTAL_SALE_PRICE_PLN))
    .map((listing) => listing.id))];
  if (facebookIds.length === 0) return listings;

  // Same pagination/id-chunking as fetchListingsByIds above: an unranged
  // select silently truncates past ~1000 rows, and an .in("listing_id",
  // [...]) filter with ~400+ UUIDs fails outright past PostgREST's ~16KB
  // header limit. facebookIds is usually small, but a filter with many
  // ambiguous-priced Facebook listings must not silently break either way.
  const idChunkSize = 200;
  const pageSize = 1000;
  const rows: Row[] = [];
  for (let idStart = 0; idStart < facebookIds.length; idStart += idChunkSize) {
    const idChunk = facebookIds.slice(idStart, idStart + idChunkSize);
    for (let start = 0; ; start += pageSize) {
      const { data, error } = await supabase
        .from("listing_source_metadata")
        .select("listing_id,metadata,collected_at")
        .in("listing_id", idChunk)
        .eq("source", "facebook")
        .order("listing_id", { ascending: true })
        .range(start, start + pageSize - 1);
      if (error) throw new Error("Nie udało się pobrać intencji ofert Facebooka do przeliczenia.");
      const page = asRows(data);
      rows.push(...page);
      if (page.length < pageSize) break;
    }
  }

  const latestByListingId = new Map<string, { intent: string | null; collectedAt: string | null }>();
  for (const row of rows) {
    const listingId = nullableString(row.listing_id);
    if (!listingId) continue;
    const collectedAt = nullableString(row.collected_at);
    const previous = latestByListingId.get(listingId);
    if (previous?.collectedAt && collectedAt && collectedAt <= previous.collectedAt) continue;
    const metadata = isRow(row.metadata) ? row.metadata : {};
    latestByListingId.set(listingId, { intent: nullableString(metadata.listingIntent), collectedAt });
  }

  return listings.map((listing) => listing.source === "facebook"
    ? { ...listing, listingIntent: latestByListingId.get(listing.id)?.intent ?? null }
    : listing);
}

// Exported for the allowlist regression test (mirrors filter-results.ts's
// own toListingRow export, used for the exact same purpose there).
export function toListing(row: Row): RecalculationListing | null {
  const id = nullableString(row.id);
  const source = nullableString(row.source);
  const originalUrl = nullableString(row.original_url);

  if (!id || !originalUrl || !isListingSource(source)) {
    return null;
  }

  return {
    id,
    source,
    originalUrl,
    title: nullableString(row.title),
    description: nullableString(row.description),
    price: nullableNumber(row.price),
    area: nullableNumber(row.area),
    pricePerSqm: nullableNumber(row.price_per_sqm),
    rooms: nullableNumber(row.rooms),
    floor: nullableString(row.floor),
    city: nullableString(row.city),
    district: nullableString(row.district),
    locationText: nullableString(row.address),
    buildingType: nullableString(row.building_type),
    ownership: nullableString(row.ownership),
    manualDecision: row.manual_decision === "ACCEPTED" || row.manual_decision === "REJECTED" ? row.manual_decision : null,
    lifecycleStatus: row.lifecycle_status === "ACTIVE" || row.lifecycle_status === "REVIEW" || row.lifecycle_status === "STALE" || row.lifecycle_status === "ARCHIVED" || row.lifecycle_status === "REJECTED" ? row.lifecycle_status : null,
  };
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(isRow) : [];
}

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function sameReasons(previous: string[], next: string[]): boolean {
  if (previous.length !== next.length) return false;
  const sortedPrevious = [...previous].sort();
  const sortedNext = [...next].sort();
  return sortedPrevious.every((value, index) => value === sortedNext[index]);
}

function isMissingAuditTable(error: { code?: unknown; message?: unknown }): boolean {
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return code === "42P01" || code === "PGRST205" || /listing_filter_match_audit/i.test(message);
}

// A bare re-export of the shared, exhaustively-checked LISTING_SOURCES
// allowlist (search-filter-contract.ts) adapted for this file's
// `string | null` call site. This file's own hand-maintained local copy
// previously only recognized otodom/olx/morizon/facebook and silently
// dropped every newer registered source (gratka, nieruchomosci_online,
// domiporta, sprzedajemy, adresowo, oferty_net, szybko, bezposrednio, domy,
// allegro_lokalnie, official_cooperative, official_uml, official_auction) --
// toListing() returning null for any of those sources made their real,
// already-saved listings invisible to this recalculation pass, so
// planFilterMatchRecalculation (which compares "listings visible now"
// against "matches that currently exist") reported them as listing_missing
// and removed them from the filter's matches even though nothing about the
// listing itself had changed. The exact same bug, in filter-results.ts, was
// already found and fixed this same way; this file was missed.
function isListingSource(value: string | null): value is RecalculationListing["source"] {
  return value !== null && isKnownListingSource(value);
}
