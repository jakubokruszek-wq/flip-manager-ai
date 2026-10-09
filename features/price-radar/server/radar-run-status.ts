import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { RadarRun } from "@/features/price-radar/types";

export async function latestRadarRun(ownerId: string, client = createAdminClient()): Promise<RadarRun | null> {
  const { data, error } = await client.from("price_radar_runs").select("*").eq("owner_id", ownerId).order("started_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error("Nie udało się odczytać stanu Radaru.");
  if (!data) return null;
  const checkpoint = data.checkpoint && typeof data.checkpoint === "object" && !Array.isArray(data.checkpoint) ? data.checkpoint : {};
  const record = checkpoint as Record<string, unknown>;
  return {
    id: String(data.id), ownerId, leaseToken: null,
    leaseUntil: typeof data.lease_until === "string" ? data.lease_until : null,
    status: data.status === "pending" || data.status === "running" || data.status === "completed" || data.status === "failed" || data.status === "partial" ? data.status : "failed",
    startedAt: String(data.started_at), finishedAt: typeof data.finished_at === "string" ? data.finished_at : null,
    checkpoint: record as unknown as RadarRun["checkpoint"],
    scannedCount: typeof data.scanned_count === "number" ? data.scanned_count : 0,
    qualifiedCount: typeof data.qualified_count === "number" ? data.qualified_count : 0,
    errorMessage: typeof data.error_message === "string" ? data.error_message : null,
    sourceStatuses: data.source_statuses && typeof data.source_statuses === "object" ? data.source_statuses as RadarRun["sourceStatuses"] : {},
    sourceErrors: record.sourceErrors && typeof record.sourceErrors === "object" ? record.sourceErrors as Record<string, string> : {},
  };
}
