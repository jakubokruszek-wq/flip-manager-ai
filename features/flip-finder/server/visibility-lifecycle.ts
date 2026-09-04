import "server-only";

import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";

export type VisibilityLifecycleCleanupResult = {
  stale: number;
  archived: number;
};

/** Runs the additive 7/14-day visibility cleanup in one database transaction. */
export async function runVisibilityLifecycleCleanup(now = new Date().toISOString()): Promise<VisibilityLifecycleCleanupResult> {
  const supabase = createFacebookWatcherAdminClient();
  const { data, error } = await supabase.rpc("cleanup_listing_visibility_lifecycle", { p_now: now });
  if (error) throw new Error(`Nie udało się wyczyścić cyklu widoczności ofert: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    stale: number(row && typeof row === "object" ? row.stale_count : null),
    archived: number(row && typeof row === "object" ? row.archived_count : null),
  };
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}
