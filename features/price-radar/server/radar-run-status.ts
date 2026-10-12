import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeRadarQualificationRejections } from "@/features/price-radar/qualification";
import type { RadarRun } from "@/features/price-radar/types";

export async function latestRadarRun(ownerId: string, client = createAdminClient()): Promise<RadarRun | null> {
  const { data, error } = await client.from("price_radar_runs").select("*").eq("owner_id", ownerId).order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("Nie udało się odczytać stanu Radaru.");
  if (!data) return null;
  const checkpoint = data.checkpoint && typeof data.checkpoint === "object" && !Array.isArray(data.checkpoint) ? data.checkpoint : {};
  const record = checkpoint as Record<string, unknown>;
  const qualificationRejections = normalizeRadarQualificationRejections(record.qualificationRejections);
  const sourceStatuses = data.source_statuses && typeof data.source_statuses === "object" ? data.source_statuses as RadarRun["sourceStatuses"] : {};
  let olxJobStatus: RadarRun["olxJobStatus"];
  let olxJobLeaseUntil: string | null = null;
  if (sourceStatuses.olx === "running") {
    const job = await client.from("olx_scan_jobs").select("status,leased_until")
      .eq("context_type", "price_radar").eq("radar_owner_id", ownerId).eq("radar_run_id", String(data.id))
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (job.error) olxJobStatus = "unavailable";
    else if (!job.data) olxJobStatus = "missing";
    else {
      olxJobStatus = job.data.status === "queued" || job.data.status === "running" || job.data.status === "completed" || job.data.status === "failed" ? job.data.status : "unavailable";
      olxJobLeaseUntil = typeof job.data.leased_until === "string" ? job.data.leased_until : null;
    }
  }
  return {
    id: String(data.id), ownerId, leaseToken: null,
    leaseUntil: typeof data.lease_until === "string" ? data.lease_until : null,
    stopRequestedAt: typeof data.stop_requested_at === "string" ? data.stop_requested_at : null,
    userTerminatedAt: typeof data.user_terminated_at === "string" ? data.user_terminated_at : null,
    status: data.status === "pending" || data.status === "running" || data.status === "completed" || data.status === "failed" || data.status === "partial" ? data.status : "failed",
    startedAt: String(data.started_at), finishedAt: typeof data.finished_at === "string" ? data.finished_at : null,
    lastProgressAt: typeof record.lastProgressAt === "string" ? record.lastProgressAt : null,
    ...(olxJobStatus ? { olxJobStatus, olxJobLeaseUntil } : {}),
    checkpoint: { ...record, qualificationRejections } as unknown as RadarRun["checkpoint"],
    scannedCount: typeof data.scanned_count === "number" ? data.scanned_count : 0,
    qualifiedCount: typeof data.qualified_count === "number" ? data.qualified_count : 0,
    errorMessage: typeof data.error_message === "string" ? data.error_message : null,
    sourceStatuses,
    sourceErrors: record.sourceErrors && typeof record.sourceErrors === "object" ? record.sourceErrors as Record<string, string> : {},
    sourceWarnings: record.sourceWarnings && typeof record.sourceWarnings === "object" ? record.sourceWarnings as RadarRun["sourceWarnings"] : {},
    sourceRejectionCounts: record.sourceRejectionCounts && typeof record.sourceRejectionCounts === "object" ? record.sourceRejectionCounts as RadarRun["sourceRejectionCounts"] : {},
    qualificationRejections,
  };
}
