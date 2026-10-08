import "server-only";

import { createClient } from "@/lib/supabase/server";

export type RadarExclusionResult = { ok: true } | { ok: false; reason: "not_found" };

/** Radar-only bookkeeping on the listing's own row -- never touches public.listings, canonical reconciliation, or any Finder/Watcher table. Persists across refresh and the next collection run (persistRadarListing's upsert never writes these two columns). */
export async function excludeRadarListing(listingId: string, reason: string | null): Promise<RadarExclusionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("price_radar_listings")
    .update({ excluded_at: new Date().toISOString(), excluded_reason: reason })
    .eq("id", listingId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("Nie udało się wykluczyć oferty z Radaru.");
  return data ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function restoreRadarListing(listingId: string): Promise<RadarExclusionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("price_radar_listings")
    .update({ excluded_at: null, excluded_reason: null })
    .eq("id", listingId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error("Nie udało się przywrócić oferty do Radaru.");
  return data ? { ok: true } : { ok: false, reason: "not_found" };
}
