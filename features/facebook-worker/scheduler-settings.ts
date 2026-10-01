import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { parseWatcherScanInterval, storedWatcherScanInterval } from "./scheduler-settings-contract";

export { parseWatcherScanInterval, storedWatcherScanInterval, WatcherScanIntervalValidationError } from "./scheduler-settings-contract";

type Row = Record<string, unknown>;

export function isActiveFacebookFilter(row: Row): boolean {
  return row.is_active === true && Array.isArray(row.sources) && row.sources.includes("facebook");
}

export async function getWatcherScanIntervalMinutes(): Promise<number> {
  const supabase = createAdminClient();
  const result = await supabase
    .from("search_filters")
    .select("id,sources,is_active,scan_interval_minutes,updated_at")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (result.error) throw new Error(`WATCHER_SCAN_INTERVAL_READ_FAILED: ${result.error.message}`);
  const row = (Array.isArray(result.data) ? result.data : []).find((candidate) => isActiveFacebookFilter(candidate as Row)) as Row | undefined;
  return storedWatcherScanInterval(row?.scan_interval_minutes);
}

/**
 * The existing search_filters column is the durable scheduler setting. Keep
 * every active Facebook filter aligned so this setting remains global even
 * when more than one filter is enabled; watched groups never receive their
 * own cadence.
 */
export async function saveWatcherScanIntervalMinutes(value: unknown): Promise<number> {
  const intervalMinutes = parseWatcherScanInterval(value);
  const supabase = createAdminClient();
  const result = await supabase
    .from("search_filters")
    .select("id,sources,is_active")
    .eq("is_active", true)
    .limit(100);
  if (result.error) throw new Error(`WATCHER_SCAN_INTERVAL_READ_FAILED: ${result.error.message}`);
  const targets = (Array.isArray(result.data) ? result.data : [])
    .map((candidate) => candidate as Row)
    .filter(isActiveFacebookFilter);
  if (targets.length === 0) throw new Error("WATCHER_SCAN_INTERVAL_NO_ACTIVE_FILTER");
  for (const target of targets) {
    const updated = await supabase
      .from("search_filters")
      .update({ scan_interval_minutes: intervalMinutes })
      .eq("id", target.id);
    if (updated.error) throw new Error(`WATCHER_SCAN_INTERVAL_WRITE_FAILED: ${updated.error.message}`);
  }
  return intervalMinutes;
}
