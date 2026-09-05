import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { SourceListing } from "@/features/flip-finder/server/search-source-registry";
import { priceObservationChanged, toResaleCompRecord } from "./resale-comps";

type Row = Record<string, unknown>;
type SyncResult = { saved: boolean; created: boolean; compId: string | null; available: boolean };

/**
 * Best-effort sidecar persistence.  A missing/unmigrated sidecar never blocks
 * the regular listing pipeline; once the migration is present, each observed
 * renovation candidate is upserted and price history is appended on change.
 */
export async function syncResaleCompFromListing(
  supabase: SupabaseClient,
  listing: SourceListing,
  sourceListingId: string | null = null,
  now = new Date().toISOString(),
): Promise<SyncResult> {
  const record = toResaleCompRecord(listing, now);
  if (!record.classification.isCandidate) return { saved: false, created: false, compId: null, available: true };

  const values = {
    source: record.source,
    external_listing_id: record.externalListingId,
    canonical_url: record.canonicalUrl,
    title: record.title,
    description: record.description,
    city: record.city,
    district: record.district,
    street: record.street,
    address: record.address,
    latitude: record.latitude ?? null,
    longitude: record.longitude ?? null,
    price: record.price,
    area_m2: record.areaM2,
    price_per_m2: record.pricePerM2,
    rooms: record.rooms,
    floor: record.floor,
    floors: record.floors ?? null,
    building_type: record.buildingType,
    construction_year: record.constructionYear ?? null,
    ownership: record.ownership ?? null,
    balcony: record.balcony ?? null,
    elevator: record.elevator ?? null,
    parking: record.parking ?? null,
    renovation_status: record.classification.renovationStatus,
    renovation_confidence: record.classification.renovationConfidence,
    finish_level: record.classification.finishLevel,
    listing_created_at: record.listingCreatedAt ?? null,
    last_seen_at: now,
    active: record.active ?? true,
    seller_type: record.sellerType ?? null,
    fingerprint: record.fingerprint,
    outlier_reason: record.classification.outlierReason,
    evidence: {
      signals: record.classification.evidence,
      sourceListingId,
      syncedAt: now,
    },
    updated_at: now,
  };

  const table = supabase.from("resale_comps");
  let existing: Row | null = null;
  let lookup = await table.select("id,price,price_per_m2").eq("source", record.source).eq("external_listing_id", record.externalListingId).maybeSingle();
  if (isMissingTable(lookup.error)) return { saved: false, created: false, compId: null, available: false };
  if (lookup.error) throw new Error(`RESALE_COMP_LOOKUP_FAILED: ${lookup.error.message}`);
  existing = asRow(lookup.data);

  if (!existing && record.canonicalUrl) {
    lookup = await table.select("id,price,price_per_m2").eq("canonical_url", record.canonicalUrl).maybeSingle();
    if (lookup.error) throw new Error(`RESALE_COMP_URL_LOOKUP_FAILED: ${lookup.error.message}`);
    existing = asRow(lookup.data);
  }
  if (!existing && record.fingerprint) {
    lookup = await table.select("id,price,price_per_m2").eq("fingerprint", record.fingerprint).maybeSingle();
    if (lookup.error) throw new Error(`RESALE_COMP_FINGERPRINT_LOOKUP_FAILED: ${lookup.error.message}`);
    existing = asRow(lookup.data);
  }

  let compId: string;
  let created = false;
  if (existing && typeof existing.id === "string") {
    compId = existing.id;
    const updated = await table.update(values).eq("id", compId).select("id").single();
    if (updated.error || !asRow(updated.data)?.id) throw new Error(`RESALE_COMP_UPDATE_FAILED: ${updated.error?.message ?? "brak ID"}`);
    if (shouldAppendPriceHistory(existing, values.price, values.price_per_m2)) await appendPriceHistory(supabase, compId, values.price, values.price_per_m2, now);
  } else {
    const inserted = await table.insert({ ...values, first_seen_at: now }).select("id").single();
    if (inserted.error || !asRow(inserted.data)?.id) {
      // A concurrent collector can win the source/url/fingerprint unique key.
      // Re-read by the strongest key and update instead of creating a duplicate.
      if (inserted.error?.code === "23505") {
        const retry = await findExisting(table, record);
        if (!retry.error && typeof asRow(retry.data)?.id === "string") {
          compId = String(asRow(retry.data)?.id);
          const updated = await table.update(values).eq("id", compId);
          if (updated.error) throw new Error(`RESALE_COMP_UPDATE_AFTER_RACE_FAILED: ${updated.error.message}`);
          if (shouldAppendPriceHistory(asRow(retry.data), values.price, values.price_per_m2)) await appendPriceHistory(supabase, compId, values.price, values.price_per_m2, now);
          return { saved: true, created: false, compId, available: true };
        }
      }
      throw new Error(`RESALE_COMP_INSERT_FAILED: ${inserted.error?.message ?? "brak ID"}`);
    }
    compId = String(asRow(inserted.data)?.id);
    created = true;
  }
  if (created || shouldAppendPriceHistory(existing, values.price, values.price_per_m2)) await appendPriceHistory(supabase, compId, values.price, values.price_per_m2, now);
  return { saved: true, created, compId, available: true };
}

async function findExisting(table: ReturnType<SupabaseClient["from"]>, record: ReturnType<typeof toResaleCompRecord>): Promise<{ data: Row | null; error: { code?: unknown; message?: unknown } | null }> {
  let result = await table.select("id,price,price_per_m2").eq("source", record.source).eq("external_listing_id", record.externalListingId).maybeSingle();
  if (result.data || result.error) return { data: asRow(result.data), error: result.error };
  if (record.canonicalUrl) {
    result = await table.select("id,price,price_per_m2").eq("canonical_url", record.canonicalUrl).maybeSingle();
    if (result.data || result.error) return { data: asRow(result.data), error: result.error };
  }
  if (record.fingerprint) {
    result = await table.select("id,price,price_per_m2").eq("fingerprint", record.fingerprint).maybeSingle();
    return { data: asRow(result.data), error: result.error };
  }
  return { data: null, error: null };
}

export function shouldAppendPriceHistory(row: Row | null, price: number | null, pricePerM2: number | null): boolean {
  return priceObservationChanged(row ? { price: numberValue(row.price), pricePerM2: numberValue(row.price_per_m2) } : null, price, pricePerM2);
}

async function appendPriceHistory(supabase: SupabaseClient, compId: string, price: number | null, pricePerM2: number | null, observedAt: string): Promise<void> {
  const { error } = await supabase.from("resale_comp_price_history").insert({ comp_id: compId, observed_at: observedAt, price, price_per_m2: pricePerM2 });
  if (error && !isMissingTable(error)) throw new Error(`RESALE_COMP_PRICE_HISTORY_FAILED: ${error.message}`);
}

function isMissingTable(error: { code?: unknown; message?: unknown } | null): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /resale_comps|resale_comp_price_history/i.test(String(error.message));
}

function asRow(value: unknown): Row | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
