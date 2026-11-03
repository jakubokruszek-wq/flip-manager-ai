import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

/** Configure the independent timer from the trusted production runtime.
 * Credentials travel server-to-server only; nothing is returned to a browser.
 * A failed setup must never discard a collected portion or expose RPC details.
 */
export async function ensureRadarWatchdog(client?: SupabaseClient, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (env.VERCEL_ENV !== "production" || !env.PRICE_RADAR_CRON_SECRET) return false;
  try {
    const request = (client ?? createAdminClient()).rpc("ensure_price_radar_watchdog", {
      p_secret: env.PRICE_RADAR_CRON_SECRET,
    });
    const { data, error } = await request.abortSignal(AbortSignal.timeout(4_000));
    if (!error && data === true) return true;
  } catch { /* recovery setup is separate from saving the scan */ }
  console.warn("RADAR_WATCHDOG_SETUP_FAILED");
  return false;
}
