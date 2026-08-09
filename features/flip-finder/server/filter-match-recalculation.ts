import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
  planFilterMatchRecalculation,
  type RecalculationListing,
  type RecalculationMatch,
} from "@/features/flip-finder/filter-match-recalculation-plan";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { createClient } from "@/lib/supabase/server";

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
};

export async function recalculateFilterMatches(
  searchFilterId: string,
): Promise<FilterRecalculationResult | null> {
  const filter = await getSearchFilter(searchFilterId);

  if (!filter) {
    return null;
  }

  const supabase = await createClient();
  const [listings, matches] = await Promise.all([
    fetchListingsForSources(supabase, filter),
    fetchMatches(supabase, searchFilterId),
  ]);
  const missingMatchedIds = matches
    .map((match) => match.listingId)
    .filter((listingId) => !listings.some((listing) => listing.id === listingId));
  const missingMatchedListings = await fetchListingsByIds(supabase, missingMatchedIds);
  const plan = planFilterMatchRecalculation(filter, [...listings, ...missingMatchedListings], matches);

  if (plan.removedListingIds.length > 0) {
    const { error } = await supabase
      .from("listing_filter_matches")
      .delete()
      .eq("search_filter_id", searchFilterId)
      .in("listing_id", plan.removedListingIds);

    if (error) {
      throw new Error("Nie udało się usunąć nieaktualnych dopasowań.");
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
    const { error } = await supabase.from("listing_filter_matches").insert(matchRows);

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
  };
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
      .select("id,source,original_url,title,price,area,price_per_sqm,rooms,floor,city,district,address,building_type,ownership")
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
    .select("listing_id")
    .eq("search_filter_id", filterId);

  if (error) {
    throw new Error("Nie udało się pobrać istniejących dopasowań.");
  }

  return asRows(data)
    .map((row) => nullableString(row.listing_id))
    .filter((listingId): listingId is string => listingId !== null)
    .map((listingId) => ({ listingId }));
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
    .select("id,source,original_url,title,price,area,price_per_sqm,rooms,floor,city,district,address,building_type,ownership")
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

function isListingSource(value: string | null): value is RecalculationListing["source"] {
  return value === "otodom" || value === "olx" || value === "morizon" || value === "facebook";
}
