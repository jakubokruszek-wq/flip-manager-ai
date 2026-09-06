import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
  planFilterMatchRecalculation,
  type RecalculationListing,
  type RecalculationMatch,
} from "@/features/flip-finder/filter-match-recalculation-plan";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { createClient } from "@/lib/supabase/server";
import {
  canReconcileNegativeResults,
  membershipAuditEntry,
  reconciliationMembershipState,
  visibleMembership,
  type MembershipAuditEntry,
} from "@/features/flip-finder/membership-reconciliation";

type Row = Record<string, unknown>;

export type FilterRecalculationResult = {
  evaluated: number;
  matchesBefore: number;
  addedMatches: number;
  removedMatches: number;
  unchangedMatches: number;
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
};

export async function recalculateFilterMatches(
  searchFilterId: string,
  options: FilterRecalculationOptions = {},
): Promise<FilterRecalculationResult | null> {
  const filter = await getSearchFilter(searchFilterId);

  if (!filter) {
    return null;
  }

  const supabase = await createClient();
  const matches = await fetchMatches(supabase, searchFilterId);
  const reconciliation = await readReconciliationDecision(supabase, searchFilterId, options);
  if (!reconciliation.allowed) {
    return blockedResult(matches.filter((match) => visibleMembership({ isCurrentMatch: match.isCurrentMatch !== false, matchReasons: match.matchReasons ?? [] })).length, reconciliation.reason);
  }

  const listings = await fetchListingsForSources(supabase, filter);
  const missingMatchedIds = matches
    .map((match) => match.listingId)
    .filter((listingId) => !listings.some((listing) => listing.id === listingId));
  const missingMatchedListings = await fetchListingsByIds(supabase, missingMatchedIds);
  const plan = planFilterMatchRecalculation(filter, [...listings, ...missingMatchedListings], matches);

  if (plan.removedListingIds.length > 0) {
    const auditRows = plan.removedListingIds.map((listingId) => {
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
    const { error } = await supabase
      .from("listing_filter_matches")
      .update({ is_current_match: false, match_reasons: ["reconciled_out", "complete_scan_filter_mismatch"], match_origin: "filter_recalculation" })
      .eq("search_filter_id", searchFilterId)
      .in("listing_id", plan.removedListingIds);

    if (error) {
      throw new Error("Nie udało się wygasić nieaktualnych dopasowań.");
    }
  }

  if (plan.addedListingIds.length > 0) {
    const matchRows = plan.addedListingIds.map((listingId) => ({
      listing_id: listingId,
      search_filter_id: searchFilterId,
      is_current_match: true,
      match_reasons: ["filter_recalculation"],
      match_score: null,
      match_origin: "filter_recalculation",
      source_scan_id: null,
    }));
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
    const { error } = await supabase.from("listing_filter_matches").upsert(matchRows, { onConflict: "listing_id,search_filter_id" });

    if (error) {
      throw new Error("Nie udało się dodać przeliczonych dopasowań.");
    }
  }

  return {
    evaluated: plan.evaluated,
    matchesBefore: plan.matchesBefore,
    addedMatches: plan.addedListingIds.length,
    removedMatches: plan.removedListingIds.length,
    unchangedMatches: plan.unchangedListingIds.length,
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
  supabase: Awaited<ReturnType<typeof createClient>>,
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
  supabase: Awaited<ReturnType<typeof createClient>>,
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
  supabase: Awaited<ReturnType<typeof createClient>>,
  filter: SearchFilter,
): Promise<RecalculationListing[]> {
  const rows: Row[] = [];
  const pageSize = 500;

  for (let start = 0; ; start += pageSize) {
    const { data, error } = await supabase
      .from("listings")
      .select("id,source,original_url,title,price,area,price_per_sqm,rooms,floor,city,district,address,building_type,ownership,manual_decision,lifecycle_status")
      .in("source", filter.sources)
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
  supabase: Awaited<ReturnType<typeof createClient>>,
  filterId: string,
): Promise<RecalculationMatch[]> {
  const { data, error } = await supabase
    .from("listing_filter_matches")
    .select("listing_id,is_current_match,match_reasons")
    .eq("search_filter_id", filterId);

  if (error) {
    throw new Error("Nie udało się pobrać istniejących dopasowań.");
  }

  return asRows(data).flatMap((row) => {
    const listingId = nullableString(row.listing_id);
    return listingId
      ? [{ listingId, isCurrentMatch: row.is_current_match !== false, matchReasons: stringArray(row.match_reasons) }]
      : [];
  });
}

async function fetchListingsByIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<RecalculationListing[]> {
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("listings")
    .select("id,source,original_url,title,price,area,price_per_sqm,rooms,floor,city,district,address,building_type,ownership,manual_decision,lifecycle_status")
    .in("id", ids);

  if (error) {
    throw new Error("Nie udało się pobrać obecnych wyników do przeliczenia.");
  }

  return asRows(data).map(toListing).filter((listing): listing is RecalculationListing => listing !== null);
}

function toListing(row: Row): RecalculationListing | null {
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

function isMissingAuditTable(error: { code?: unknown; message?: unknown }): boolean {
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return code === "42P01" || code === "PGRST205" || /listing_filter_match_audit/i.test(message);
}

function isListingSource(value: string | null): value is RecalculationListing["source"] {
  return value === "otodom" || value === "olx" || value === "morizon" || value === "facebook";
}
