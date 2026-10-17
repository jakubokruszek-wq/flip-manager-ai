import { normalizeFacebookSourceUrl } from "../facebook-production.ts";
import { AndroidJobError, readAndroidJobStatus, type AndroidJobStore } from "./jobs.ts";

export type AndroidSourceRow = { id: string; name: string; url: string; priority: string; enabled: boolean; access_status: string };
export type AndroidMetadataAction = "sources/sync" | "device/status" | "diagnostics";
export type AndroidMetadataDependencies = {
  enabled: () => boolean;
  authenticate: (request: Request, path: string, body: string) => Promise<string>;
  loadSources: (deviceId: string) => Promise<AndroidSourceRow[]>;
  store: () => AndroidJobStore;
};
/** Full authorized snapshot only; clients mark missing IDs removed locally. */
export async function handleAndroidMetadata(request: Request, action: AndroidMetadataAction, deps: AndroidMetadataDependencies) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  try {
    if (request.method !== "POST") throw new AndroidJobError(405, "METHOD_NOT_ALLOWED");
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new AndroidJobError(415, "JSON_REQUIRED");
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) try {
      for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > 8192) { await reader.cancel(); throw new AndroidJobError(413, "PAYLOAD_TOO_LARGE"); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks).toString("utf8");
    const deviceId = await deps.authenticate(request, `/api/collector/android/${action}`, body);
    let value: unknown; try { value = JSON.parse(body); } catch { throw new AndroidJobError(400, "INVALID_PAYLOAD"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AndroidJobError(400, "INVALID_PAYLOAD");
    if (!deps.enabled()) throw new AndroidJobError(503, "ANDROID_INTEGRATION_DISABLED");
    if (action === "device/status") return json({ ok: true, deviceId, consumerType: "ANDROID_WEBVIEW", paired: true, imageMode: "SOURCE_SCAN_DATA_ONLY", heartbeatIntervalSeconds: 45 });
    if (action === "diagnostics") return json(await readAndroidJobStatus(deps.store(), deviceId, value));
    const rows = await deps.loadSources(deviceId);
    if (rows.length > 50 || new Set(rows.map(row => row.id)).size !== rows.length) throw new AndroidJobError(503, "ANDROID_SOURCE_SNAPSHOT_INVALID");
    const sources = rows.map(row => {
      const normalized = normalizeFacebookSourceUrl(row.url);
      return { id: row.id, name: row.name, url: normalized?.url ?? null, sourceId: normalized?.sourceId ?? null, type: normalized?.type ?? null,
        priority: row.priority, enabled: row.enabled && !!normalized && ["CONNECTED", "MANUAL_IMPORT"].includes(row.access_status),
        serverEnabled: row.enabled, accessStatus: normalized ? row.access_status : "UNAVAILABLE",
        unavailableCode: normalized ? (row.access_status === "UNAVAILABLE" ? "SOURCE_UNAVAILABLE" : null) : "SOURCE_URL_INVALID" };
    });
    return json({ ok: true, completeSnapshot: true, sources });
  } catch (error) {
    const known = error instanceof AndroidJobError;
    return json({ ok: false, code: known ? error.code : "ANDROID_METADATA_UNAVAILABLE", retryable: !known || error.status === 503 }, known ? error.status : 503);
  }
}
