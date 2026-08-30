import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import { createAdminClient } from "@/lib/supabase/admin";
import { FACEBOOK_PRODUCTION_SOURCE_ID, FACEBOOK_PRODUCTION_SOURCE_URL, isCollectorHeartbeatFresh } from "./facebook-production";

export { FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS } from "./facebook-production";

export type CollectorReadiness = {
  ready: boolean;
  deviceId: string | null;
  lastHeartbeatAt: string | null;
  health: string | null;
  reason: string | null;
};

export type FacebookCollectorScan = {
  sourceScanId: string;
  sourceId: typeof FACEBOOK_PRODUCTION_SOURCE_ID;
  sourceUrl: typeof FACEBOOK_PRODUCTION_SOURCE_URL;
  deviceId: string;
};

export async function readCollectorReadiness(now = Date.now()): Promise<CollectorReadiness> {
  const supabase = createAdminClient();
  const result = await supabase
    .from("collector_devices")
    .select("id,last_heartbeat_at,health_status,revoked_at")
    .is("revoked_at", null)
    .not("last_heartbeat_at", "is", null)
    .order("last_heartbeat_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) throw new Error(`COLLECTOR_READINESS_QUERY_FAILED: ${result.error.message}`);
  const row = result.data;
  const lastHeartbeatAt = typeof row?.last_heartbeat_at === "string" ? row.last_heartbeat_at : null;
  const ready = Boolean(row?.id && lastHeartbeatAt && isCollectorHeartbeatFresh(lastHeartbeatAt, now, typeof row.health_status === "string" ? row.health_status : null));
  return {
    ready,
    deviceId: typeof row?.id === "string" ? row.id : null,
    lastHeartbeatAt,
    health: typeof row?.health_status === "string" ? row.health_status : null,
    reason: ready ? null : "COLLECTOR_OFFLINE_OR_HEARTBEAT_STALE",
  };
}

export async function enqueueFacebookCollectorScan(filter: SearchFilter, runId: string): Promise<FacebookCollectorScan> {
  const readiness = await readCollectorReadiness();
  if (!readiness.ready || !readiness.deviceId) throw new Error("COLLECTOR_OFFLINE");
  const supabase = createAdminClient();
  const scan = await supabase.from("source_scans").insert({
    search_filter_id: filter.id,
    source: "facebook",
    status: "pending",
    scan_run_id: runId,
    filter_snapshot: filter,
    warnings: ["FACEBOOK_COLLECTOR_DISPATCH_PENDING", `FACEBOOK_SOURCE_ALLOWLIST:${FACEBOOK_PRODUCTION_SOURCE_ID}`],
  }).select("id").single();
  if (scan.error || !scan.data?.id) throw new Error(`FACEBOOK_COLLECTOR_SOURCE_SCAN_CREATE_FAILED: ${scan.error?.message ?? "missing id"}`);
  return { sourceScanId: String(scan.data.id), sourceId: FACEBOOK_PRODUCTION_SOURCE_ID, sourceUrl: FACEBOOK_PRODUCTION_SOURCE_URL, deviceId: readiness.deviceId };
}
