import "server-only";
import { runAndroidDataOnlyImport } from "./import-policy";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "../signed-device-auth";
import { processFacebookCollectorBatch } from "../facebook-batch-server";
import { AndroidJobError, type AndroidJobRow, type AndroidJobStore } from "./jobs";
import { handleAndroidRequest, type AndroidAction } from "./handler";

export function androidJobStore(): AndroidJobStore {
  const db = createFacebookWatcherAdminClient();
  return {
    rpc: (name, args) => db.rpc(name, args),
    loadCompletedBatch: async (binding) => {
      const result = await db.from("collector_scan_batches").select("status,result")
        .eq("device_id", binding.deviceId).eq("batch_id", binding.batchId).eq("scan_id", binding.runId)
        .eq("source_id", binding.sourceId).eq("source_url", binding.sourceUrl)
        .in("status", ["completed", "degraded", "failed"]).maybeSingle();
      if (result.error) throw new AndroidJobError(503, "ANDROID_QUEUE_UNAVAILABLE");
      const saved = result.data?.result;
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
      const row = saved as Record<string, unknown>;
      return row.batchId === binding.batchId && row.status === result.data.status && Array.isArray(row.sourceScanIds) && row.sourceScanIds.includes(binding.sourceScanId)
        ? row as { status: string } : null;
    },
    loadJob: async (id) => {
      const result = await db.from("facebook_scan_jobs").select("id,scan_run_id,source_scan_id,search_filter_id,group_snapshot,consumer_type,job_type,status,lease_token,leased_until,worker_id,attempts,android_completion_state,android_completion_started_at,android_receipt").eq("id", id).maybeSingle();
      if (result.error) throw new AndroidJobError(503, "ANDROID_QUEUE_UNAVAILABLE");
      return result.data as AndroidJobRow | null;
    },
  };
}
export function androidRoute(request: Request, action: AndroidAction) {
  return handleAndroidRequest(request, action, {
    enabled: () => process.env.FACEBOOK_ANDROID_QUEUE_ENABLED === "true",
    store: androidJobStore,
    processBatch: (deviceId, batch, context) => runAndroidDataOnlyImport(() => processFacebookCollectorBatch(deviceId, batch, { ...context, qualityReport: process.env.FACEBOOK_ANDROID_DIAGNOSTICS_ENABLED === "true" })),
    authenticate: async (request, pathname, body) => {
      try {
        const { device } = await authenticateSignedCollectorRequest({ request, pathname, body, markHealthy: true, expectedConsumerType: "ANDROID_WEBVIEW" });
        return device.id;
      } catch (error) {
        if (error instanceof SignedCollectorAuthError) throw new AndroidJobError(error.status, error.code);
        throw error;
      }
    },
  });
}
