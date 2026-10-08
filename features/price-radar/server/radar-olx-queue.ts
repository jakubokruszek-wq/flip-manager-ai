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
  const existing = await client.from("olx_scan_jobs").select("id,status").eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing.error) throw new Error("RADAR_OLX_QUEUE_READ_FAILED");
  if (existing.data?.id && existing.data.status === "failed") throw new Error("RADAR_OLX_JOB_ALREADY_FAILED");
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
