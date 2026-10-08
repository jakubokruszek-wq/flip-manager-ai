import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export type RadarExclusionResult = { ok: true } | { ok: false; reason: "not_found" };

/** Radar-only bookkeeping; the RPC propagates exclusion only across explicit cross-portal identity evidence. */
export async function excludeRadarListing(ownerId: string, listingId: string, reason: string | null, supabase = createAdminClient()): Promise<RadarExclusionResult> {
  const { data, error } = await supabase.rpc("set_price_radar_listing_exclusion", { p_owner_id: ownerId, p_listing_id: listingId, p_excluded: true, p_reason: reason });
  if (error) throw new Error("Nie udało się wykluczyć oferty z Radaru.");
  return data === true ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function restoreRadarListing(ownerId: string, listingId: string, supabase = createAdminClient()): Promise<RadarExclusionResult> {
  const { data, error } = await supabase.rpc("set_price_radar_listing_exclusion", { p_owner_id: ownerId, p_listing_id: listingId, p_excluded: false, p_reason: null });
  if (error) throw new Error("Nie udało się przywrócić oferty do Radaru.");
  return data === true ? { ok: true } : { ok: false, reason: "not_found" };
}
