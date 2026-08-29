export const COLLECTOR_DISCOVERY_LAYERS = ["DOM", "HYDRATION", "NETWORK", "SEARCH_DOM", "SEARCH_HYDRATION", "SEARCH_NETWORK"] as const;
export type CollectorDiscoveryLayer = (typeof COLLECTOR_DISCOVERY_LAYERS)[number];
export type CollectorSourceType = "GROUP" | "PROFILE";
export type CollectorDiscoveryHealth = "HEALTHY" | "DEGRADED" | "FAILED";

export type CollectorMediaRecord = {
  url: string;
  mediaId: string | null;
  exactPostId: string | null;
  exactAssociation: boolean;
  discoveryLayers: CollectorDiscoveryLayer[];
};

export type CollectorPostRecord = {
  postId: string;
  permalink: string;
  sourceId: string;
  sourceType: CollectorSourceType;
  author: string | null;
  text: string | null;
  publishedAt: string | null;
  timestampText: string | null;
  media: CollectorMediaRecord[];
  discoveryLayers: CollectorDiscoveryLayer[];
  firstSeenIteration: number;
};

export type CollectorSourceHealth = {
  status: CollectorDiscoveryHealth;
  visibleCardCount: number;
  capturedPostCount: number;
  captureRatio: number;
  scrolls: number;
  durationMs: number;
  stopReason: string;
  reasons: string[];
};

export type FacebookCollectorBatch = {
  scanId: string;
  batchId: string;
  sourceId: string;
  sourceType: CollectorSourceType;
  sourceUrl: string;
  collectedAt: string;
  health: CollectorSourceHealth;
  posts: CollectorPostRecord[];
};

export function normalizeFacebookCollectorBatch(value: unknown): FacebookCollectorBatch {
  if (!isRecord(value)) throw new Error("COLLECTOR_BATCH_INVALID");
  const sourceType = enumValue(value.sourceType, ["GROUP", "PROFILE"] as const, "COLLECTOR_SOURCE_TYPE_INVALID");
  const sourceUrl = facebookSourceUrl(requiredString(value.sourceUrl, "COLLECTOR_SOURCE_URL_REQUIRED"), sourceType);
  const sourceId = requiredString(value.sourceId, "COLLECTOR_SOURCE_ID_REQUIRED");
  if (facebookSourceId(sourceUrl, sourceType) !== sourceId) throw new Error("COLLECTOR_SOURCE_URL_ID_MISMATCH");
  const posts = Array.isArray(value.posts) ? value.posts.slice(0, 100).map((post) => normalizePost(post, sourceId, sourceType)) : [];
  const deduped = [...new Map(posts.map((post) => [post.postId || post.permalink, post])).values()];
  const health = normalizeHealth(value.health, deduped.length);
  return {
    scanId: uuid(value.scanId, "COLLECTOR_SCAN_ID_INVALID"),
    batchId: uuid(value.batchId, "COLLECTOR_BATCH_ID_INVALID"),
    sourceId,
    sourceType,
    sourceUrl,
    collectedAt: isoDate(value.collectedAt, "COLLECTOR_COLLECTED_AT_INVALID"),
    health,
    posts: deduped,
  };
}

export function evaluateCollectorHealth(input: {
  visibleCardCount: number;
  capturedPostCount: number;
  scrolls: number;
  durationMs: number;
  feedGrew: boolean;
  newIdsAfterScroll: boolean;
  failed?: boolean;
  stopReason: string;
}): CollectorSourceHealth {
  const visible = nonnegativeInteger(input.visibleCardCount);
  const captured = nonnegativeInteger(input.capturedPostCount);
  const ratio = visible === 0 ? (captured > 0 ? 1 : 0) : Math.min(1, captured / visible);
  const reasons: string[] = [];
  if (input.failed) reasons.push("COLLECTOR_SOURCE_FAILED");
  if (!input.failed && visible === 0 && captured === 0) reasons.push("COLLECTOR_NO_VISIBLE_OR_CAPTURED_POSTS");
  if (visible >= 3 && captured < 3) reasons.push("COLLECTOR_LOW_CAPTURE_COUNT");
  if (visible >= 4 && ratio < 0.6) reasons.push("COLLECTOR_LOW_CAPTURE_RATIO");
  if (input.feedGrew && !input.newIdsAfterScroll) reasons.push("COLLECTOR_GROWING_FEED_WITHOUT_NEW_IDS");
  const status: CollectorDiscoveryHealth = input.failed ? "FAILED" : reasons.length > 0 ? "DEGRADED" : "HEALTHY";
  return { status, visibleCardCount: visible, capturedPostCount: captured, captureRatio: ratio, scrolls: nonnegativeInteger(input.scrolls), durationMs: nonnegativeInteger(input.durationMs), stopReason: input.stopReason.slice(0, 120), reasons };
}

function normalizePost(value: unknown, sourceId: string, sourceType: CollectorSourceType): CollectorPostRecord {
  if (!isRecord(value)) throw new Error("COLLECTOR_POST_INVALID");
  const postId = requiredString(value.postId, "COLLECTOR_POST_ID_REQUIRED");
  const permalink = facebookPostUrl(requiredString(value.permalink, "COLLECTOR_PERMALINK_REQUIRED"), postId, sourceId, sourceType);
  if (requiredString(value.sourceId, "COLLECTOR_POST_SOURCE_ID_REQUIRED") !== sourceId || value.sourceType !== sourceType) throw new Error("COLLECTOR_POST_SOURCE_MISMATCH");
  return {
    postId,
    permalink,
    sourceId,
    sourceType,
    author: nullableString(value.author, 200),
    text: nullableString(value.text, 20_000),
    publishedAt: nullableIsoDate(value.publishedAt),
    timestampText: nullableString(value.timestampText, 300),
    media: Array.isArray(value.media) ? value.media.slice(0, 30).flatMap((media) => normalizeMedia(media, postId)) : [],
    discoveryLayers: layers(value.discoveryLayers),
    firstSeenIteration: nonnegativeInteger(value.firstSeenIteration),
  };
}

function normalizeMedia(value: unknown, postId: string): CollectorMediaRecord[] {
  if (!isRecord(value)) return [];
  const url = safeHttpsUrl(value.url);
  if (!url) return [];
  const exactPostId = nullableString(value.exactPostId, 128);
  const exactAssociation = value.exactAssociation === true && exactPostId === postId;
  return [{ url, mediaId: nullableString(value.mediaId, 128), exactPostId, exactAssociation, discoveryLayers: layers(value.discoveryLayers) }];
}

function normalizeHealth(value: unknown, captured: number): CollectorSourceHealth {
  if (!isRecord(value)) throw new Error("COLLECTOR_HEALTH_REQUIRED");
  const status = enumValue(value.status, ["HEALTHY", "DEGRADED", "FAILED"] as const, "COLLECTOR_HEALTH_INVALID");
  const visible = nonnegativeInteger(value.visibleCardCount);
  const count = nonnegativeInteger(value.capturedPostCount);
  if (count !== captured) throw new Error("COLLECTOR_CAPTURE_COUNT_MISMATCH");
  return { status, visibleCardCount: visible, capturedPostCount: count, captureRatio: visible === 0 ? (count > 0 ? 1 : 0) : Math.min(1, count / visible), scrolls: nonnegativeInteger(value.scrolls), durationMs: nonnegativeInteger(value.durationMs), stopReason: requiredString(value.stopReason, "COLLECTOR_STOP_REASON_REQUIRED").slice(0, 120), reasons: Array.isArray(value.reasons) ? value.reasons.filter((item): item is string => typeof item === "string").slice(0, 20) : [] };
}

function facebookSourceUrl(value: string, type: CollectorSourceType): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.facebook.com") throw new Error("COLLECTOR_SOURCE_URL_INVALID");
  if (type === "GROUP" && !/^\/groups\/[^/]+\/?$/i.test(url.pathname)) throw new Error("COLLECTOR_GROUP_URL_INVALID");
  url.search = ""; url.hash = ""; url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

function facebookPostUrl(value: string, postId: string, sourceId: string, sourceType: CollectorSourceType): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.facebook.com" || !url.pathname.includes(postId)) throw new Error("COLLECTOR_POST_URL_INVALID");
  if (sourceType === "GROUP" && !url.pathname.startsWith(`/groups/${sourceId}/`)) throw new Error("COLLECTOR_POST_SOURCE_URL_MISMATCH");
  if (sourceType === "PROFILE" && !url.pathname.startsWith(`/${sourceId}/`)) throw new Error("COLLECTOR_POST_SOURCE_URL_MISMATCH");
  url.search = ""; url.hash = "";
  return url.toString();
}

function facebookSourceId(value: string, type: CollectorSourceType): string | null {
  const url = new URL(value);
  if (type === "GROUP") return url.pathname.match(/^\/groups\/([^/]+)/i)?.[1] ?? null;
  return url.searchParams.get("id") ?? url.pathname.match(/^\/([^/]+)/)?.[1] ?? null;
}

function layers(value: unknown): CollectorDiscoveryLayer[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is CollectorDiscoveryLayer => typeof item === "string" && (COLLECTOR_DISCOVERY_LAYERS as readonly string[]).includes(item)))].slice(0, COLLECTOR_DISCOVERY_LAYERS.length) : [];
}

function uuid(value: unknown, code: string): string { const text = requiredString(value, code); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(code); return text; }
function isoDate(value: unknown, code: string): string { const text = requiredString(value, code); if (Number.isNaN(Date.parse(text))) throw new Error(code); return new Date(text).toISOString(); }
function nullableIsoDate(value: unknown): string | null { return value === null || value === undefined || value === "" ? null : isoDate(value, "COLLECTOR_POST_DATE_INVALID"); }
function requiredString(value: unknown, code: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(code); return value.trim(); }
function nullableString(value: unknown, max: number): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
function nonnegativeInteger(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
function safeHttpsUrl(value: unknown): string | null { if (typeof value !== "string") return null; try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; } catch { return null; } }
function enumValue<const T extends readonly string[]>(value: unknown, options: T, code: string): T[number] { if (typeof value !== "string" || !options.includes(value)) throw new Error(code); return value as T[number]; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
