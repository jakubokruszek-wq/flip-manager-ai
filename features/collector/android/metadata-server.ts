import "server-only";
import { createFacebookWatcherAdminClient } from "../../facebook-watcher/supabase-admin";
import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "../signed-device-auth";
import { AndroidJobError } from "./jobs";
import { androidJobStore } from "./server";
import { handleAndroidMetadata, type AndroidMetadataAction, type AndroidSourceRow } from "./metadata";

export function androidMetadataRoute(request: Request, action: AndroidMetadataAction) {
  return handleAndroidMetadata(request, action, {
    enabled: () => process.env.FACEBOOK_ANDROID_INTEGRATION_ENABLED === "true",
    store: androidJobStore,
    authenticate: async (request, pathname, body) => {
      try { return (await authenticateSignedCollectorRequest({ request, pathname, body, expectedConsumerType: "ANDROID_WEBVIEW", markHealthy: false })).device.id; }
      catch (error) { if (error instanceof SignedCollectorAuthError) throw new AndroidJobError(error.status, error.code); throw error; }
    },
    loadSources: async deviceId => {
      const db = createFacebookWatcherAdminClient();
      const grants = await db.from("collector_android_source_grants").select("watched_group_id,expires_at", { count: "exact" }).eq("device_id", deviceId).limit(101);
      if (grants.error || grants.count === null || grants.count !== grants.data?.length || grants.count > 100) throw new AndroidJobError(503, "ANDROID_SOURCE_SNAPSHOT_INVALID");
      const ids = [...new Set((grants.data ?? []).filter(row => row.expires_at === null || Date.parse(row.expires_at) > Date.now()).map(row => row.watched_group_id))];
      if (!ids.length) return [];
      const result = await db.from("watched_facebook_groups").select("id,name,url,priority,enabled,access_status", { count: "exact" }).in("id", ids).order("id").limit(51);
      if (result.error || result.count === null || result.count !== result.data?.length || result.count > 50) throw new AndroidJobError(503, "ANDROID_SOURCE_SNAPSHOT_INVALID");
      return result.data as AndroidSourceRow[];
    },
  });
}
