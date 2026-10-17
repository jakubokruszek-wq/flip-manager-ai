import "server-only";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { buildFacebookRunQualityReport, type FacebookQualityJob } from "./quality";

/** Admin/server read model only. Never schedules scans or reads OLX tables. */
export async function readFacebookRunQualityReport(input: { runId: string; consumerTypes?: ("ANDROID_WEBVIEW" | "BROWSER_EXTENSION")[] }) {
  if (process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED !== "true") return { enabled: false as const, report: null };
  if (!/^[0-9a-f-]{36}$/i.test(input.runId)) throw Error("FACEBOOK_REPORT_RUN_ID_INVALID");
  const consumers = input.consumerTypes ?? ["ANDROID_WEBVIEW"];
  if (!consumers.length || consumers.some(c => c !== "ANDROID_WEBVIEW" && c !== "BROWSER_EXTENSION")) throw Error("FACEBOOK_REPORT_CONSUMER_INVALID");
  const db = createFacebookWatcherAdminClient();
  const jobs = await db.from("facebook_scan_jobs").select("id,scan_run_id,source_scan_id,consumer_type,job_type,status,attempts,group_snapshot,result_summary,worker_id", { count: "exact" })
    .eq("scan_run_id", input.runId).eq("job_type", "SOURCE_SCAN").in("consumer_type", consumers).limit(501);
  if (jobs.error) throw Error("FACEBOOK_REPORT_READ_FAILED");
  if (jobs.count === null || jobs.count === undefined) throw Error("FACEBOOK_REPORT_COUNT_UNAVAILABLE");
  if (jobs.count > 500) throw Error("FACEBOOK_REPORT_SCOPE_TOO_LARGE");
  if (jobs.count !== (jobs.data?.length ?? 0)) throw Error("FACEBOOK_REPORT_TRUNCATED");
  const rows = (jobs.data ?? []) as (FacebookQualityJob & { source_scan_id: string; worker_id: string | null })[];
  // Older extension completions do not store their batch result in the job.
  // Associate only one unambiguous, fully bound persisted batch per source scan.
  if (rows.some(row => !row.result_summary)) {
    const batches = await db.from("collector_scan_batches").select("device_id,source_id,result,scan_id", { count: "exact" })
      .eq("scan_id", input.runId).in("status", ["completed", "degraded", "failed"]).limit(1001);
    if (batches.error) throw Error("FACEBOOK_REPORT_READ_FAILED");
    if (batches.count === null || batches.count === undefined) throw Error("FACEBOOK_REPORT_COUNT_UNAVAILABLE");
    if (batches.count > 1000) throw Error("FACEBOOK_REPORT_SCOPE_TOO_LARGE");
    if (batches.count !== (batches.data?.length ?? 0)) throw Error("FACEBOOK_REPORT_TRUNCATED");
    for (const job of rows.filter(row => !row.result_summary)) {
      const group = Array.isArray(job.group_snapshot) ? job.group_snapshot[0] : null;
      const candidates = (batches.data ?? []).filter(batch => batch.device_id === job.worker_id && batch.source_id === group?.sourceId
        && Array.isArray(batch.result?.sourceScanIds) && batch.result.sourceScanIds.includes(job.source_scan_id));
      if (candidates.length === 1) job.result_summary = candidates[0].result;
    }
  }
  return { enabled: true as const, report: buildFacebookRunQualityReport(rows, { runId: input.runId, consumerTypes: consumers }) };
}
