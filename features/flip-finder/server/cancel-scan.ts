import "server-only";

import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { cancellationPatch, isValidScanRunId } from "@/features/flip-finder/scan-cancel";

export async function cancelScanRun(runId: string): Promise<{ runId: string; cancelledJobs: number; cancelledSources: number }> {
  if (!isValidScanRunId(runId)) {
    throw new Error("INVALID_SCAN_RUN_ID");
  }

  const supabase = createFacebookWatcherAdminClient();
  const now = new Date().toISOString();
  const run = await supabase.from("source_scans").select("source").eq("scan_run_id", runId);
  if (run.error) throw new Error(`SCAN_CANCEL_READ_FAILED: ${run.error.message}`);
  const hasFacebook = (run.data ?? []).some((row) => row.source === "facebook");
  const [jobs, sources] = await Promise.all([
    hasFacebook ? supabase
      .from("facebook_scan_jobs")
      .update(cancellationPatch(now))
      .eq("scan_run_id", runId)
      .in("status", ["queued", "running"])
      .select("id") : { data: [], error: null },
    supabase
      .from("source_scans")
      .update({ status: "failed", error_message: "SCAN_CANCELLED", finished_at: now, continuation_next_at: null, continuation_lease_until: null, continuation_lease_token: null })
      .eq("scan_run_id", runId)
      .in("status", ["pending", "running"])
      .select("id"),
  ]);
  if (jobs.error) throw new Error(`SCAN_CANCEL_JOBS_FAILED: ${jobs.error.message}`);
  if (sources.error) throw new Error(`SCAN_CANCEL_SOURCES_FAILED: ${sources.error.message}`);
  return { runId, cancelledJobs: jobs.data?.length ?? 0, cancelledSources: sources.data?.length ?? 0 };
}
