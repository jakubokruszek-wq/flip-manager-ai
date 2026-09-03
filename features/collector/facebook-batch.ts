export const COLLECTOR_DISCOVERY_LAYERS = ["DOM", "HYDRATION", "NETWORK", "SEARCH_DOM", "SEARCH_HYDRATION", "SEARCH_NETWORK", "SEARCH_MEDIA_RESOLVE"] as const;
export type CollectorDiscoveryLayer = (typeof COLLECTOR_DISCOVERY_LAYERS)[number];
export type CollectorSourceType = "GROUP" | "PROFILE";
export type CollectorDiscoveryHealth = "HEALTHY" | "DEGRADED" | "FAILED";
export type CollectorIdentityConfidence = "EXACT" | "UNVERIFIED";
export type CollectorDiscoverySource = "MAIN_FEED" | "SEARCH";
export type CollectorFirstSeenPhase = "MAIN_FEED" | "SEARCH";

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
  identityConfidence: CollectorIdentityConfidence;
  identityReasons: string[];
  discoverySource: CollectorDiscoverySource;
  searchQuery: string | null;
  searchQueries: string[];
  foundInMainFeed: boolean;
  firstSeenPhase: CollectorFirstSeenPhase;
  resolvedFromMediaTile: boolean;
  mediaIds: string[];
  parentResolutionEvidence: string[];
  rootPostId?: string | null;
  rootAuthorSource?: string | null;
  rootTextSource?: string | null;
  rootTextVerified?: boolean;
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

export type CollectorSearchQueryTelemetry = {
  query: string;
  executed: boolean;
  status: CollectorDiscoveryHealth;
  scrolls: number;
  visibleCards: number;
  captured: number;
  unique: number;
  duplicatesVsMainFeed: number;
  uniqueContribution: number;
  sellContribution: number;
  tilesSeen: number;
  tilesOpened: number;
  tilesResolved: number;
  tilesUnverified: number;
  uniqueParentPosts: number;
  verifiedParentPosts: number;
  duplicatesByMedia: number;
  durationMs: number;
  stopReason: string;
  tileDiagnostics?: CollectorSearchTileDiagnostic[];
};

export type CollectorSearchTileDiagnostic = {
  query: string;
  mediaId: string;
  photoOpened: boolean;
  structuredPayloadFound: boolean;
  currMediaId: string | null;
  containerStoryPostId: string | null;
  topLevelPostId: string | null;
  mediaAttachmentCrosscheck: boolean;
  parentPostId: string | null;
  parentPermalink: string | null;
  rootAuthorFound: boolean;
  rootTextFound: boolean;
  identityResult: CollectorIdentityConfidence;
  failSubstep: string | null;
  elapsedMs: number;
};

export type CollectorMainFeedDiagnostic = {
  postId: string;
  sourceLayer: "NETWORK" | "DOM" | "BOTH";
  structuredAuthorPresent: boolean;
  structuredTextPresent: boolean;
  structuredTextPath: string | null;
  rootCardFound: boolean;
  rootCardPostIdBound: boolean;
  rootCardPermalink: string | null;
  rootAuthorFound: boolean;
  rootTextFound: boolean;
  seeMorePresent: boolean;
  seeMoreClicked: boolean;
  rootTextAfterExpand: boolean;
  authorMatch: boolean;
  postIdMatch: boolean;
  finalIdentity: CollectorIdentityConfidence;
  failSubstep: string | null;
};

export type CollectorSearchTelemetry = {
  hardTimeBudgetMs: number;
  durationMs: number;
  queriesPlanned: number;
  queriesExecuted: number;
  budgetExhausted: boolean;
  queries: CollectorSearchQueryTelemetry[];
};

export type FacebookCollectorBatch = {
  scanId: string;
  batchId: string;
  sourceId: string;
  sourceType: CollectorSourceType;
  sourceUrl: string;
  collectedAt: string;
  health: CollectorSourceHealth;
  searchTelemetry: CollectorSearchTelemetry | null;
  mainFeedTelemetry?: CollectorMainFeedDiagnostic[];
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
    searchTelemetry: normalizeSearchTelemetry(value.searchTelemetry),
    mainFeedTelemetry: normalizeMainFeedTelemetry(value.mainFeedTelemetry),
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
  visibleFeedAdvanced?: boolean;
  capturedAdvanced?: boolean;
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
  if (input.visibleFeedAdvanced && input.capturedAdvanced === false) reasons.push("COLLECTOR_VISIBLE_FEED_ADVANCED_WITHOUT_CAPTURE_GROWTH");
  const status: CollectorDiscoveryHealth = input.failed ? "FAILED" : reasons.length > 0 ? "DEGRADED" : "HEALTHY";
  return { status, visibleCardCount: visible, capturedPostCount: captured, captureRatio: ratio, scrolls: nonnegativeInteger(input.scrolls), durationMs: nonnegativeInteger(input.durationMs), stopReason: input.stopReason.slice(0, 120), reasons };
}

function normalizePost(value: unknown, sourceId: string, sourceType: CollectorSourceType): CollectorPostRecord {
  if (!isRecord(value)) throw new Error("COLLECTOR_POST_INVALID");
  const postId = requiredString(value.postId, "COLLECTOR_POST_ID_REQUIRED");
  const permalink = facebookPostUrl(requiredString(value.permalink, "COLLECTOR_PERMALINK_REQUIRED"), postId, sourceId, sourceType);
  if (requiredString(value.sourceId, "COLLECTOR_POST_SOURCE_ID_REQUIRED") !== sourceId || value.sourceType !== sourceType) throw new Error("COLLECTOR_POST_SOURCE_MISMATCH");
  const identityConfidence: CollectorIdentityConfidence = value.identityConfidence === "EXACT" ? "EXACT" : "UNVERIFIED";
  const identityReasons = Array.isArray(value.identityReasons) ? value.identityReasons.filter((item): item is string => typeof item === "string").slice(0, 10) : [];
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
    identityConfidence,
    identityReasons: identityReasons.length > 0 ? identityReasons : identityConfidence === "EXACT" ? [] : ["COLLECTOR_IDENTITY_EVIDENCE_MISSING"],
    discoverySource: value.discoverySource === "SEARCH" ? "SEARCH" : "MAIN_FEED",
    searchQuery: nullableString(value.searchQuery, 120),
    searchQueries: Array.isArray(value.searchQueries) ? value.searchQueries.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 120)).filter(Boolean).slice(0, 20) : [],
    foundInMainFeed: value.foundInMainFeed === true || value.discoverySource !== "SEARCH",
    firstSeenPhase: value.firstSeenPhase === "SEARCH" ? "SEARCH" : "MAIN_FEED",
    resolvedFromMediaTile: value.resolvedFromMediaTile === true,
    mediaIds: Array.isArray(value.mediaIds) ? value.mediaIds.filter((item): item is string => typeof item === "string" && /^\d{5,30}$/.test(item)).slice(0, 30) : [],
    parentResolutionEvidence: Array.isArray(value.parentResolutionEvidence) ? value.parentResolutionEvidence.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 120)).slice(0, 10) : [],
    rootPostId: nullableString(value.rootPostId, 128),
    rootAuthorSource: nullableString(value.rootAuthorSource, 120),
    rootTextSource: nullableString(value.rootTextSource, 120),
    rootTextVerified: value.rootTextVerified === true,
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

function normalizeSearchTelemetry(value: unknown): CollectorSearchTelemetry | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new Error("COLLECTOR_SEARCH_TELEMETRY_INVALID");
  const queries = Array.isArray(value.queries) ? value.queries.slice(0, 20).map(normalizeSearchQueryTelemetry) : [];
  return {
    hardTimeBudgetMs: boundedInteger(value.hardTimeBudgetMs, 1_000, 90_000),
    durationMs: boundedInteger(value.durationMs, 0, 120_000),
    queriesPlanned: boundedInteger(value.queriesPlanned, 0, 20),
    queriesExecuted: boundedInteger(value.queriesExecuted, 0, queries.length),
    budgetExhausted: value.budgetExhausted === true,
    queries,
  };
}

function normalizeSearchQueryTelemetry(value: unknown): CollectorSearchQueryTelemetry {
  if (!isRecord(value)) throw new Error("COLLECTOR_SEARCH_QUERY_TELEMETRY_INVALID");
  return {
    query: requiredString(value.query, "COLLECTOR_SEARCH_QUERY_REQUIRED").slice(0, 120),
    executed: value.executed === true,
    status: enumValue(value.status, ["HEALTHY", "DEGRADED", "FAILED"] as const, "COLLECTOR_SEARCH_QUERY_STATUS_INVALID"),
    scrolls: boundedInteger(value.scrolls, 0, 30),
    visibleCards: boundedInteger(value.visibleCards, 0, 10_000),
    captured: boundedInteger(value.captured, 0, 100),
    unique: boundedInteger(value.unique, 0, 100),
    duplicatesVsMainFeed: boundedInteger(value.duplicatesVsMainFeed, 0, 100),
    uniqueContribution: boundedInteger(value.uniqueContribution, 0, 100),
    sellContribution: boundedInteger(value.sellContribution, 0, 100),
    tilesSeen: boundedInteger(value.tilesSeen, 0, 10_000),
    tilesOpened: boundedInteger(value.tilesOpened, 0, 10),
    tilesResolved: boundedInteger(value.tilesResolved, 0, 10),
    tilesUnverified: boundedInteger(value.tilesUnverified, 0, 10_000),
    uniqueParentPosts: boundedInteger(value.uniqueParentPosts, 0, 10),
    verifiedParentPosts: boundedInteger(value.verifiedParentPosts, 0, 10),
    duplicatesByMedia: boundedInteger(value.duplicatesByMedia, 0, 10),
    durationMs: boundedInteger(value.durationMs, 0, 120_000),
    stopReason: requiredString(value.stopReason, "COLLECTOR_SEARCH_QUERY_STOP_REASON_REQUIRED").slice(0, 120),
    ...(Array.isArray(value.tileDiagnostics) ? { tileDiagnostics: value.tileDiagnostics.slice(0, 10).map(normalizeSearchTileDiagnostic) } : {}),
  };
}

function normalizeSearchTileDiagnostic(value: unknown): CollectorSearchTileDiagnostic {
  if (!isRecord(value)) throw new Error("COLLECTOR_SEARCH_TILE_DIAGNOSTIC_INVALID");
  const id = nullableString(value.mediaId, 30);
  return {
    query: requiredString(value.query, "COLLECTOR_SEARCH_TILE_QUERY_REQUIRED").slice(0, 120),
    mediaId: id && /^\d{5,30}$/.test(id) ? id : "0",
    photoOpened: value.photoOpened === true,
    structuredPayloadFound: value.structuredPayloadFound === true,
    currMediaId: nullableString(value.currMediaId, 30),
    containerStoryPostId: nullableString(value.containerStoryPostId, 30),
    topLevelPostId: nullableString(value.topLevelPostId, 30),
    mediaAttachmentCrosscheck: value.mediaAttachmentCrosscheck === true,
    parentPostId: nullableString(value.parentPostId, 30),
    parentPermalink: safeHttpsUrl(value.parentPermalink),
    rootAuthorFound: value.rootAuthorFound === true,
    rootTextFound: value.rootTextFound === true,
    identityResult: value.identityResult === "EXACT" ? "EXACT" : "UNVERIFIED",
    failSubstep: nullableString(value.failSubstep, 120),
    elapsedMs: boundedInteger(value.elapsedMs, 0, 120_000),
  };
}

function normalizeMainFeedTelemetry(value: unknown): CollectorMainFeedDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((item) => {
    if (!isRecord(item)) return [];
    const postId = nullableString(item.postId, 30);
    if (!postId || !/^\d{5,30}$/.test(postId)) return [];
    return [{ postId, sourceLayer: item.sourceLayer === "DOM" || item.sourceLayer === "BOTH" ? item.sourceLayer : "NETWORK", structuredAuthorPresent: item.structuredAuthorPresent === true, structuredTextPresent: item.structuredTextPresent === true, structuredTextPath: nullableString(item.structuredTextPath, 120), rootCardFound: item.rootCardFound === true, rootCardPostIdBound: item.rootCardPostIdBound === true, rootCardPermalink: safeHttpsUrl(item.rootCardPermalink), rootAuthorFound: item.rootAuthorFound === true, rootTextFound: item.rootTextFound === true, seeMorePresent: item.seeMorePresent === true, seeMoreClicked: item.seeMoreClicked === true, rootTextAfterExpand: item.rootTextAfterExpand === true, authorMatch: item.authorMatch === true, postIdMatch: item.postIdMatch === true, finalIdentity: item.finalIdentity === "EXACT" ? "EXACT" : "UNVERIFIED", failSubstep: nullableString(item.failSubstep, 120) }];
  });
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
function boundedInteger(value: unknown, min: number, max: number): number { return Math.min(max, Math.max(min, nonnegativeInteger(value))); }
function safeHttpsUrl(value: unknown): string | null { if (typeof value !== "string") return null; try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; } catch { return null; } }
function enumValue<const T extends readonly string[]>(value: unknown, options: T, code: string): T[number] { if (typeof value !== "string" || !options.includes(value)) throw new Error(code); return value as T[number]; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
