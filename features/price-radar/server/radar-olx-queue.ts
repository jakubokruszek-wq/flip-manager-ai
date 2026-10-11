import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { assertAllowedOlxUrl } from "@/features/flip-finder/olx-parser";
import { slugifyCity } from "@/features/flip-finder/server/search-source-registry";
import { createAdminClient } from "@/lib/supabase/admin";

export type RadarOlxQueueJob = { id: string; status: "queued" | "running" | "completed" };

/** Enqueues OLX in its existing worker queue without creating Finder source_scans or memberships. */
export async function enqueueRadarOlxJob(input: { ownerId: string; runId: string; leaseToken: string; city: string }, client: SupabaseClient = createAdminClient()): Promise<RadarOlxQueueJob> {
  const requestUrl = assertAllowedOlxUrl(`https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/${slugifyCity(input.city)}/`).toString();
  const idempotencyKey = `price-radar:${input.ownerId}:olx:${input.runId}`;
  const existing = await client.from("olx_scan_jobs").select("id,status,error_code,radar_owner_id,radar_run_id,result_summary,finished_at")
    .eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing.error) throw new Error("RADAR_OLX_QUEUE_READ_FAILED");
  if (existing.data?.id && existing.data.status === "failed") {
    if (existing.data.error_code !== "RADAR_STOPPED_BY_OPERATOR"
      || existing.data.radar_owner_id !== input.ownerId
      || existing.data.radar_run_id !== input.runId) throw new Error("RADAR_OLX_JOB_ALREADY_FAILED");

    // Resume the exact reservation that STOP failed. Keep its stable job ID
    // and idempotency key; ordinary terminal failures are never retried here.
    const resumedAt = new Date().toISOString();
    const priorSummary = isRecord(existing.data.result_summary) ? existing.data.result_summary : {};
    const priorStopHistory = Array.isArray(priorSummary.operatorStopHistory)
      ? priorSummary.operatorStopHistory.filter(isRecord).slice(-9)
      : [];
    const stopHistoryEntry = {
      stoppedAt: typeof existing.data.finished_at === "string" ? existing.data.finished_at : null,
      resumedAt,
    };
    const resumed = await client.from("olx_scan_jobs").update({
      status: "queued",
      available_at: resumedAt,
      finished_at: null,
      lease_token: null,
      leased_until: null,
      worker_id: null,
      heartbeat_at: null,
      radar_lease_token: input.leaseToken,
      error_code: null,
      error_message: null,
      result_summary: { ...priorSummary, operatorStopHistory: [...priorStopHistory, stopHistoryEntry] },
    }).eq("id", existing.data.id).eq("idempotency_key", idempotencyKey)
      .eq("radar_owner_id", input.ownerId).eq("radar_run_id", input.runId)
      .eq("status", "failed").eq("error_code", "RADAR_STOPPED_BY_OPERATOR")
      .select("id,status").maybeSingle();
    if (resumed.error) throw new Error("RADAR_OLX_JOB_RESUME_FAILED");
    if (resumed.data?.id && resumed.data.status === "queued") return { id: String(resumed.data.id), status: "queued" };
    // A second claimant may have already requeued the same idempotent row.
    const current = await client.from("olx_scan_jobs").select("id,status")
      .eq("idempotency_key", idempotencyKey).maybeSingle();
    if (!current.error && current.data?.id && (current.data.status === "queued" || current.data.status === "running" || current.data.status === "completed")) {
      return { id: String(current.data.id), status: current.data.status };
    }
    throw new Error("RADAR_OLX_JOB_RESUME_FAILED");
  }
  if (existing.data?.id && (existing.data.status === "queued" || existing.data.status === "running" || existing.data.status === "completed")) {
    return { id: String(existing.data.id), status: existing.data.status };
  }

  const { data, error } = await client.from("olx_scan_jobs").insert({
    context_type: "price_radar",
    scan_run_id: input.runId,
    source_scan_id: null,
    search_filter_id: null,
    radar_owner_id: input.ownerId,
    radar_run_id: input.runId,
    radar_lease_token: input.leaseToken,
    request_url: requestUrl,
    filter_snapshot: { context: "price_radar", ownerId: input.ownerId, city: input.city },
    idempotency_key: idempotencyKey,
  }).select("id,status").single();
  if (!error && data?.id && isQueueStatus(data.status)) return { id: String(data.id), status: data.status };
  if (error?.code === "23505") {
    const duplicate = await client.from("olx_scan_jobs").select("id,status").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (!duplicate.error && duplicate.data?.id && (duplicate.data.status === "queued" || duplicate.data.status === "running" || duplicate.data.status === "completed")) return { id: String(duplicate.data.id), status: duplicate.data.status };
  }
  throw new Error("RADAR_OLX_QUEUE_INSERT_FAILED");
}

function isQueueStatus(value: unknown): value is RadarOlxQueueJob["status"] {
  return value === "queued" || value === "running" || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
