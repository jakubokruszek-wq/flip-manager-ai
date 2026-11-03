import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { activeRadarListingExternalIds } from "./persist-radar-listing";

export const RADAR_BACKLOG_SOURCES = new Set(["gratka", "morizon", "otodom", "oferty_net", "domiporta", "adresowo", "allegro_lokalnie"]);
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const str = (value: unknown): string | null => typeof value === "string" ? value : null;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;

/** Owner-scoped, bounded seeds. These are untrusted hints; every detail is fetched again. */
export async function readRadarVerificationBacklog(db: SupabaseClient, ownerId: string, source: string, fixedIds?: readonly string[]) {
  let query = db.from("price_radar_verification_queue")
    .select("id,status,source,external_listing_id,original_url,normalized_url,title,source_snapshot")
    .eq("owner_id", ownerId).eq("source", source);
  if (fixedIds) query = query.in("id", [...fixedIds]);
  else query = query.eq("status", "pending").order("last_seen_at", { ascending: true });
  const { data, error } = await query;
  if (error) {
    if (["42P01", "PGRST205"].includes(error.code)) return { ids: [], listings: [] };
    throw new Error("Nie udało się odczytać kolejki automatycznej weryfikacji Radaru.");
  }
  const rows = (Array.isArray(data) ? data as Row[] : []).slice(0, fixedIds ? 300 : 1000);
  const active = new Set<string>();
  // Keep REST URLs bounded. Filter already qualified rows before taking the
  // next 300 slots, otherwise old active records could starve the backlog.
  for (let offset = 0; offset < rows.length; offset += 150) {
    for (const id of await activeRadarListingExternalIds(db, ownerId, source, rows.slice(offset, offset + 150).map((row) => String(row.external_listing_id)))) active.add(id);
  }
  const selected = fixedIds ? fixedIds.map((id) => rows.find((row) => row.id === id) ?? { id, status: "missing" })
    : rows.filter((row) => !active.has(String(row.external_listing_id))).slice(0, 300);
  return {
    ids: selected.map((row) => String(row.id)),
    listings: selected.map((row): PropertySourceListing => {
      const snapshot = record(row.source_snapshot);
      const externalId = String(row.external_listing_id ?? row.id);
      return {
        source: source as PropertySourceListing["source"], externalListingId: externalId,
        originalUrl: str(row.original_url) ?? "", normalizedUrl: str(row.normalized_url) ?? str(row.original_url) ?? "",
        title: str(row.title), description: str(snapshot.description), price: num(snapshot.price), area: num(snapshot.area),
        pricePerSqm: num(snapshot.pricePerSqm), rooms: num(snapshot.rooms), floor: null,
        city: str(snapshot.city), district: str(snapshot.district), locationText: null, buildingType: str(snapshot.buildingType),
        thumbnailUrl: null, ownership: null, images: [], publishedAt: str(snapshot.publishedAt),
        contentHash: str(snapshot.contentHash) ?? `${source}:${externalId}`,
        rawPayload: { ...record(snapshot.rawPayload), marketType: snapshot.marketType,
          detailVerified: false, radarSearchScope: "apartment-sale",
          radarBacklogSkip: row.status !== "pending" || active.has(externalId) },
      };
    }),
  };
}
