import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_RADAR_FILTERS, normalizeRadarFilters } from "@/features/price-radar/settings";
import type { RadarFilters } from "@/features/price-radar/types";

export async function readRadarSettings(ownerId: string, client = createAdminClient()): Promise<RadarFilters> {
  const { data, error } = await client.from("price_radar_settings").select("filters").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error("Nie udało się odczytać zapisanych filtrów Radaru.");
  return data ? normalizeRadarFilters(data.filters) : { ...DEFAULT_RADAR_FILTERS, districts: [...DEFAULT_RADAR_FILTERS.districts], rooms: [], sources: [] };
}

export async function writeRadarSettings(ownerId: string, filters: unknown, client = createAdminClient()): Promise<RadarFilters> {
  const normalized = normalizeRadarFilters(filters);
  const { error } = await client.from("price_radar_settings").upsert({ owner_id: ownerId, filters: normalized, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
  if (error) throw new Error("Nie udało się zapisać filtrów Radaru.");
  return normalized;
}
