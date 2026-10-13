import "server-only";

import { normalizeStructuredBuildingType } from "@/features/flip-finder/listing-attribute-extraction";
import { isOperatorConfirmableBuildingType, type OperatorConfirmableBuildingType } from "@/features/flip-finder/building-type-qualification";

type QueryResult = { data: unknown; error: { code?: unknown; message?: unknown } | null };
type ReadClient = { from(table: string): { select(columns: string): { in(column: string, values: string[]): PromiseLike<QueryResult> } } };
type WriteClient = {
  from(table: string): {
    upsert(row: Record<string, unknown>, options: { onConflict: string }): { select(columns: string): PromiseLike<QueryResult> };
    delete(): { eq(column: string, value: string): PromiseLike<QueryResult> };
  };
};

export const BUILDING_CONFIRMATIONS_TABLE = "finder_building_type_confirmations";
const ID_CHUNK = 200;

export type BuildingTypeConfirmations = { available: boolean; byListing: Map<string, string> };

/**
 * Operator building-type confirmations are a separate table (not
 * listings.building_type) because every scan rewrites the listing's own
 * structured columns from source data; an operator decision must survive
 * that. Before the migration is applied the table is missing and Finder
 * simply reports the feature as unavailable.
 */
export async function readBuildingTypeConfirmations(supabase: ReadClient, listingIds: readonly string[]): Promise<BuildingTypeConfirmations> {
  const byListing = new Map<string, string>();
  for (let offset = 0; offset < listingIds.length; offset += ID_CHUNK) {
    const chunk = listingIds.slice(offset, offset + ID_CHUNK);
    const result = await supabase.from(BUILDING_CONFIRMATIONS_TABLE).select("listing_id,building_type").in("listing_id", chunk);
    if (result.error) {
      if (isMissingTable(result.error)) return { available: false, byListing: new Map() };
      console.error("FLIP FINDER BUILDING CONFIRMATIONS ERROR:", result.error);
      throw new Error("Nie udało się pobrać potwierdzeń typu budynku.");
    }
    for (const row of Array.isArray(result.data) ? result.data : []) {
      const record = row as Record<string, unknown>;
      const type = normalizeStructuredBuildingType(record.building_type);
      if (typeof record.listing_id === "string" && type) byListing.set(record.listing_id, type);
    }
  }
  return { available: true, byListing };
}

export class BuildingConfirmationUnavailableError extends Error {
  constructor() {
    super("Potwierdzanie typu budynku wymaga zastosowania migracji finder_building_type_confirmations.");
    this.name = "BuildingConfirmationUnavailableError";
  }
}

export async function saveBuildingTypeConfirmation(supabase: WriteClient, input: { listingId: string; buildingType: OperatorConfirmableBuildingType; operatorId: string; note: string | null; now?: string }): Promise<void> {
  if (!isOperatorConfirmableBuildingType(input.buildingType)) throw new Error("Nieprawidłowy typ budynku.");
  const result = await supabase.from(BUILDING_CONFIRMATIONS_TABLE).upsert({
    listing_id: input.listingId,
    building_type: input.buildingType,
    confirmed_by: input.operatorId,
    confirmed_at: input.now ?? new Date().toISOString(),
    note: input.note,
  }, { onConflict: "listing_id" }).select("listing_id");
  if (result.error) {
    if (isMissingTable(result.error)) throw new BuildingConfirmationUnavailableError();
    if (result.error.code === "23503") throw new Error("Nie znaleziono oferty.");
    console.error("FLIP FINDER BUILDING CONFIRMATION WRITE ERROR:", result.error);
    throw new Error("Nie udało się zapisać typu budynku.");
  }
}

export async function clearBuildingTypeConfirmation(supabase: WriteClient, listingId: string): Promise<void> {
  const result = await supabase.from(BUILDING_CONFIRMATIONS_TABLE).delete().eq("listing_id", listingId);
  if (result.error) {
    if (isMissingTable(result.error)) throw new BuildingConfirmationUnavailableError();
    throw new Error("Nie udało się usunąć potwierdzenia typu budynku.");
  }
}

function isMissingTable(error: { code?: unknown; message?: unknown }): boolean {
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  return (code === "42P01" || code === "PGRST205") && message.includes(BUILDING_CONFIRMATIONS_TABLE);
}
