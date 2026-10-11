import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { DEFAULT_RADAR_FILTERS, normalizeRadarFilters } from "@/features/price-radar/settings";
import type { RadarFilters } from "@/features/price-radar/types";

export async function readRadarSettings(ownerId: string, client = createAdminClient()): Promise<RadarFilters> {
  const { data, error } = await client.from("price_radar_settings").select("filters").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error("Nie udało się odczytać zapisanych filtrów Radaru.");
  return data ? normalizeRadarFilters(data.filters) : { ...DEFAULT_RADAR_FILTERS, districts: [...DEFAULT_RADAR_FILTERS.districts], rooms: [], sources: [] };
}

/**
 * An EMPTY sources array already means "every active source" everywhere
 * collection is started (claimOrCreateRadarRun). That is only correct for
 * an operator who genuinely never narrowed their portals. A saved row that
 * explicitly named one or more sources, all of which have since been
 * disabled (e.g. szybko), must never be silently reinterpreted as "run
 * everything" -- the caller must surface this instead of starting a scan.
 */
export async function radarSettingsSourcesWereFilteredToEmpty(ownerId: string, client = createAdminClient()): Promise<boolean> {
  const { data, error } = await client.from("price_radar_settings").select("filters").eq("owner_id", ownerId).maybeSingle();
  if (error || !data) return false;
  const raw = data.filters;
  const rawSources = raw !== null && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as Record<string, unknown>).sources)
    ? (raw as Record<string, unknown>).sources as unknown[]
    : [];
  if (rawSources.length === 0) return false;
  return normalizeRadarFilters(raw).sources.length === 0;
}

export async function writeRadarSettings(ownerId: string, filters: unknown, client = createAdminClient()): Promise<RadarFilters> {
  const normalized = normalizeRadarFilters(filters);
  const { error } = await client.from("price_radar_settings").upsert({ owner_id: ownerId, filters: normalized, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
  if (error) throw new Error("Nie udało się zapisać filtrów Radaru.");
  return normalized;
}
