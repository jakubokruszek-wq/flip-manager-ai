import "server-only";

import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";

/** Finder never reserves Facebook source rows; those belong to Watcher. Nor
 * OLX rows: OLX is not a stage of a Finder run, and the separate OLX schedule
 * (Cloudflare) creates its own source_scans row under its own scan_run_id,
 * which must never be taken for the latest portals' scan.
 * Discover only the latest run ID, without listings, filter snapshots or jobs.
 * The progress reader separately groups ALL source rows of that exact run.
 */
export async function getLatestFinderRun(filterId: string): Promise<{ runId: string | null }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(filterId)) throw new Error("INVALID_FILTER_ID");
  const supabase = createFacebookWatcherAdminClient();
  const { data, error } = await supabase.from("source_scans")
    .select("scan_run_id")
    .eq("search_filter_id", filterId)
    .not("source", "in", "(facebook,olx)")
    .not("scan_run_id", "is", null)
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .abortSignal(AbortSignal.timeout(12_000));
  if (error) throw new Error(`FINDER_RUN_READ_FAILED: ${error.message}`);
  const latest = Array.isArray(data) ? data[0] : null;
  return { runId: typeof latest?.scan_run_id === "string" ? latest.scan_run_id : null };
}
