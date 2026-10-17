import { normalizeFacebookSourceUrl } from "../facebook-production.ts";

export type FacebookPlanningSource = {
  id: string; name: string; url: string; enabled: boolean; priority: "high" | "normal" | "low";
  last_checked_at: string | null; access_status: string;
};
export type FacebookScanObservation = {
  sourceId: string; sourceType?: "GROUP" | "PROFILE"; finishedAt: string; status: "completed" | "partial" | "failed";
  durationMs: number | null; listingsCreated: number | null; listingsUpdated: number | null;
};
export type FacebookScanPlanItem = {
  groupId: string; sourceId: string; name: string; url: string; type: "GROUP" | "PROFILE";
  priority: FacebookPlanningSource["priority"]; overdue: boolean; lastScannedAt: string | null;
  score: number; observedScans: number; medianDurationMs: number | null; reasons: string[];
};
/** Preview/plan only: no database client, cron, queue mutation, or network calls. */
export function planAndroidFacebookScans(input: {
  sources: FacebookPlanningSource[]; history: FacebookScanObservation[]; now?: number;
  enabled?: boolean; preview?: boolean; limit?: number;
}) {
  const mode = input.preview === true ? "PREVIEW" : input.enabled === true ? "PLAN_ONLY" : "DISABLED";
  if (mode === "DISABLED") return { source: "facebook" as const, consumerType: "ANDROID_WEBVIEW" as const, mode, items: [] as FacebookScanPlanItem[], deferred: [] as { groupId: string; reason: string }[] };
  const now = input.now ?? Date.now(); const seen = new Set<string>(); const items: FacebookScanPlanItem[] = []; const deferred: { groupId: string; reason: string }[] = [];
  for (const source of input.sources) {
    if (source.enabled !== true) { deferred.push({ groupId: source.id, reason: "SOURCE_DISABLED" }); continue; }
    const normalized = normalizeFacebookSourceUrl(source.url);
    if (!normalized) { deferred.push({ groupId: source.id, reason: "SOURCE_URL_INVALID" }); continue; }
    if (["AUTH_REQUIRED", "UNAVAILABLE"].includes(source.access_status)) { deferred.push({ groupId: source.id, reason: "ACCESS_REQUIRES_ATTENTION" }); continue; }
    if (!["high", "normal", "low"].includes(source.priority)) { deferred.push({ groupId: source.id, reason: "PRIORITY_INVALID" }); continue; }
    if (!["CONNECTED", "MANUAL_IMPORT"].includes(source.access_status)) { deferred.push({ groupId: source.id, reason: "ACCESS_STATUS_UNKNOWN" }); continue; }
    const sourceKey = `${normalized.type}:${normalized.sourceId}`;
    if (seen.has(sourceKey)) { deferred.push({ groupId: source.id, reason: "DUPLICATE_SOURCE" }); continue; } seen.add(sourceKey);
    const history = input.history.filter(h => h.sourceId === normalized.sourceId && (h.sourceType ?? "GROUP") === normalized.type && Number.isFinite(Date.parse(h.finishedAt)) && Date.parse(h.finishedAt) <= now
      && ["completed", "partial", "failed"].includes(h.status)).sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt)).slice(0, 20);
    const durations = history.flatMap(h => finiteNonnegative(h.durationMs) && h.durationMs > 0 ? [h.durationMs] : []).sort((a, b) => a - b);
    const median = durations.length ? (durations[Math.floor((durations.length - 1) / 2)] + durations[Math.floor(durations.length / 2)]) / 2 : null;
    const yields = history.filter(h => finiteNonnegative(h.listingsCreated) && finiteNonnegative(h.listingsUpdated));
    const useful = yields.reduce((n, h) => n + h.listingsCreated! + 0.25 * h.listingsUpdated!, 0);
    const reliability = (1 + history.filter(h => h.status !== "failed").length) / (2 + history.length);
    const score = ((1 + useful) / (2 + yields.length)) * reliability * 60_000 / Math.max(15_000, median ?? 90_000);
    const timestamps = [source.last_checked_at, ...history.map(h => h.finishedAt)].filter((v): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now);
    const lastScannedAt = timestamps.length ? new Date(Math.max(...timestamps.map(Date.parse))).toISOString() : null;
    items.push({ groupId: source.id, sourceId: normalized.sourceId, name: source.name, url: normalized.url, type: normalized.type,
      priority: source.priority, overdue: lastScannedAt === null || now - Date.parse(lastScannedAt) >= 24 * 60 * 60_000,
      lastScannedAt, score: Math.round(score * 1_000_000) / 1_000_000, observedScans: history.length, medianDurationMs: median,
      reasons: ["EXPLICIT_PRIORITY", history.length ? "HISTORICAL_YIELD_AND_TIME" : "NO_HISTORY_EXPLORATION", ...(lastScannedAt === null ? ["NEVER_OBSERVED"] : [])] });
  }
  const priority = { high: 0, normal: 1, low: 2 };
  items.sort((a, b) => priority[a.priority] - priority[b.priority] || Number(b.overdue) - Number(a.overdue)
    || (a.overdue && b.overdue ? (a.lastScannedAt ?? "").localeCompare(b.lastScannedAt ?? "") : 0)
    || b.score - a.score || (a.lastScannedAt ?? "").localeCompare(b.lastScannedAt ?? "") || a.sourceId.localeCompare(b.sourceId));
  const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(50, input.limit!)) : 13;
  for (const source of items.slice(limit)) deferred.push({ groupId: source.groupId, reason: "PLAN_LIMIT" });
  return { source: "facebook" as const, consumerType: "ANDROID_WEBVIEW" as const, mode, items: items.slice(0, limit), deferred };
}
function finiteNonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
