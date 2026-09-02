"use strict";

importScripts("collector-core.js");
importScripts("collector-runtime.js");
importScripts("pairing-status.js");
importScripts("collector-preflight.js");

const PRODUCTION_SOURCE_URL = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/";
const PRODUCTION_LIMITS = { maxPosts: 50, minScrolls: 5, maxScrolls: 30, hardTimeBudgetMs: 110_000 };
const SEARCH_BUDGET_RESERVE_MS = 40_000;
const SEARCH_LIMITS = { minScrolls: 0, maxScrolls: 3, maxUniquePerQuery: 10, maxTilesToOpen: 10, tileConcurrency: 1, hardTimeBudgetPerQueryMs: 30_000, discoveryBudgetMs: 30_000, hardTimeBudgetMs: 240_000 };
const SEARCH_BUDGET_SAFETY_MS = 2_000;
const SEARCH_QUERY_CLEANUP_RESERVE_MS = 1_500;
const COLLECT_SOURCE_RESPONSE_MIN_TIMEOUT_MS = 40_000;
const COLLECT_SOURCE_RESPONSE_GRACE_MS = 20_000;
const SOURCE_COLLECTION_DEADLINE_MS = 360_000;
const FAIL_REPORT_TIMEOUT_MS = 10_000;

const DEFAULT_SOURCES = [
  "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/",
  "https://www.facebook.com/groups/402796264871862/",
  "https://www.facebook.com/groups/2928219830782023/",
  "https://www.facebook.com/groups/1253809205540869/",
  "https://www.facebook.com/groups/1424921570856189/",
  "https://www.facebook.com/groups/1689328011096404/"
];
const SEARCH_QUERIES = ["sprzedam", "na sprzedaż", "mieszkanie", "2 pokoje", "3 pokoje"];

const PRODUCTION_SEARCH_QUERIES = ["sprzedam", "na sprzedaż", "mieszkanie", "Łódź", "2 pokoje", "3 pokoje"];
void DEFAULT_SOURCES;
void SEARCH_QUERIES;
void PRODUCTION_SEARCH_QUERIES;
const ACTIVE_SEARCH_QUERIES = ["sprzedam", "na sprzeda\u017c", "mieszkanie", "do remontu", "\u0141\u00f3d\u017a", "2 pokoje", "3 pokoje"];
const PHASE_MAIN_FEED = "Skanowanie feedu\u2026";
const PHASE_FINALIZE = "Scalanie wynikow i analiza ofert\u2026";
const PHASE_DONE = "Zakonczono";

const FINDER_ORIGIN = "https://flip-manager-ai.vercel.app";
const RUNTIME_GENERATION = crypto.randomUUID();
let collectorJobPollInFlight = false;

void recoverFinderBootstraps().catch(() => {});
chrome.runtime.onInstalled.addListener(() => { void recoverFinderBootstraps().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void recoverFinderBootstraps().catch(() => {}); });
chrome.alarms.create("collector-job-poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "collector-job-poll") void pollCollectorJobs().catch(() => {}); });

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (message?.type !== "FLIP_COLLECTOR_EXTERNAL_PING" || !isAllowedExternalSender(sender) || safeRequestId(message.requestId) === "unknown") {
    respond({ ok: false, type: "FLIP_COLLECTOR_EXTERNAL_PONG", requestId: safeRequestId(message?.requestId), error: "EXTERNAL_ORIGIN_REJECTED" });
    return false;
  }
  respond({ ok: true, type: "FLIP_COLLECTOR_EXTERNAL_PONG", requestId: message.requestId });
  return false;
});

async function recoverFinderBootstraps() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !isFinderUrl(tab.url)) continue;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bootstrap.js"] }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "RECORD_START_TRACE") {
    void recordStartTrace(message).then(() => respond({ ok: true })).catch(() => respond({ ok: false }));
    return true;
  }
  if (message?.type === "COLLECT_ACTIVE_SOURCE") {
    void collectActiveSource().then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (message?.type === "COLLECT_CONFIGURED_SOURCES") {
    void collectConfiguredSources().then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (message?.type === "CHECK_COLLECTOR_READY") {
    const requestId = safeRequestId(message.requestId);
    void recordStartTrace({ requestId, stage: "EXTENSION_RECEIVED_READY", status: "PASS" }).then(() => checkCollectorReady(requestId)).then(respond).catch((error) => respond({ ok: false, status: "UNVERIFIED", error: safeError(error) }));
    return true;
  }
  if (message?.type === "REFRESH_COLLECTOR_HEALTH") {
    const requestId = safeRequestId(message.requestId);
    if (requestId === "unknown" || !isFinderUrl(_sender?.tab?.url)) { respond({ ok: false, heartbeatUpdated: false, error: "COLLECTOR_HEALTH_REFRESH_ORIGIN_REJECTED" }); return false; }
    void recordStartTrace({ requestId, stage: "EXTENSION_RECEIVED_HEALTH_REFRESH", status: "PASS" }).catch(() => {}).then(() => refreshCollectorHealth(requestId)).then(respond).catch(() => respond({ ok: false, heartbeatUpdated: false, error: "COLLECTOR_HEALTH_REFRESH_FAILED" }));
    return true;
  }
  if (message?.type === "VALIDATE_COLLECTOR") {
    const requestId = safeRequestId(message.requestId);
    if (requestId === "unknown" || !isFinderUrl(_sender?.tab?.url)) { respond({ ok: false, error: "VALIDATOR_ORIGIN_REJECTED" }); return false; }
    void validateCollector(requestId).then((validation) => respond({ ok: true, validation, error: validation.error })).catch(() => respond({ ok: false, error: "COLLECTOR_VALIDATION_FAILED" }));
    return true;
  }
  if (message?.type === "BOOTSTRAP_CONTEXT_HEALTH") {
    if (!isFinderUrl(_sender?.tab?.url) || message.origin !== FINDER_ORIGIN) { respond({ ok: false, error: "BOOTSTRAP_ORIGIN_NOT_ALLOWED" }); return false; }
    respond({ ok: true, runtimeGeneration: RUNTIME_GENERATION });
    return false;
  }
  if (message?.type === "BOOTSTRAP_LOADED") {
    if (!isFinderUrl(_sender?.tab?.url) || message.origin !== FINDER_ORIGIN || message.runtimeGeneration !== RUNTIME_GENERATION) { respond({ ok: false, error: "BOOTSTRAP_CONTEXT_STALE" }); return false; }
    void chrome.storage.local.set({ collectorBootstrapRuntime: { loadedAt: new Date().toISOString(), origin: FINDER_ORIGIN, tabId: _sender.tab.id } }).then(() => respond({ ok: true }));
    return true;
  }
  if (message?.type === "BOOTSTRAP_RUNTIME_PING") {
    const requestId = safeRequestId(message.requestId);
    if (requestId === "unknown" || !isFinderUrl(_sender?.tab?.url)) { respond({ ok: false, requestId, error: "BOOTSTRAP_ORIGIN_NOT_ALLOWED" }); return false; }
    void recordStartTrace({ requestId, stage: "BOOTSTRAP_BACKGROUND_REACHED", status: "PASS" }).then(() => respond({ ok: true, requestId }));
    return true;
  }
  if (message?.type === "COLLECT_PRODUCTION_SOURCE") {
    const scanId = typeof message.scanId === "string" && isUuid(message.scanId) ? message.scanId : null;
    if (!scanId) { respond({ ok: false, error: "COLLECTOR_SCAN_ID_INVALID" }); return false; }
    const requestId = safeRequestId(message.requestId);
    void recordStartTrace({ requestId, stage: "EXTENSION_RECEIVED_SCAN_COMMAND", status: "PASS" }).then(() => collectConfiguredSources(scanId, requestId)).catch(() => {});
    respond({ ok: true, accepted: true, scanId });
    return false;
  }
  if (message?.type === "GET_COLLECTOR_STATE") {
    void chrome.storage.local.get(["collectorState", "collectorLastResult"]).then(respond);
    return true;
  }
  if (message?.type === "GET_PAIRING_STATUS") {
    void getPairingStatus().then(respond).catch(() => respond({ status: "UNVERIFIED", label: "Po\u0142\u0105czenie niezweryfikowane", shouldVerify: true }));
    return true;
  }
  if (message?.type === "VERIFY_PAIRING_STATUS") {
    void verifyPairingStatus().then(respond).catch(() => respond({ status: "UNVERIFIED", label: "Po\u0142\u0105czenie niezweryfikowane", shouldVerify: true }));
    return true;
  }
  if (message?.type === "SAVE_PAIRING_CONFIG" && message.config) {
    const now = new Date().toISOString();
    void chrome.storage.local.set({ apiUrl: message.config.apiUrl, deviceId: message.config.deviceId, deviceToken: message.config.deviceToken, collectorPairingState: { status: "CONNECTED", apiUrl: message.config.apiUrl, deviceId: message.config.deviceId, verifiedAt: now, lastHeartbeatAt: now } }).then(() => respond({ ok: true }));
    return true;
  }
  return false;
});

async function collectActiveSource() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isProductionSource(tab.url)) throw new Error("PRODUCTION_SOURCE_NOT_ALLOWED");
  const scanId = crypto.randomUUID();
  return collectTabSource(tab.id, tab.url, scanId);
}

async function collectConfiguredSources(scanId = crypto.randomUUID(), requestId = "unknown") {
  let tab;
  const runtime = globalThis.FlipCollectorRuntime;
  const deadline = runtime.createDeadline(SOURCE_COLLECTION_DEADLINE_MS);
  const context = { deadline, lastStage: "FACEBOOK_TAB_CREATE", query: null, source: "lodzsprzedazzakupwynajem" };
  const collection = (async () => {
    tab = await chrome.tabs.create({ url: PRODUCTION_SOURCE_URL, active: false });
    context.lastStage = "FACEBOOK_TAB_LOAD";
    deadline.assertActive(failureDiagnostics(context, tab?.id));
    await waitForTab(tab.id, Math.min(30_000, Math.max(1, deadline.remainingMs())));
    deadline.assertActive(failureDiagnostics(context, tab.id));
    return collectTabSource(tab.id, PRODUCTION_SOURCE_URL, scanId, requestId, context);
  })();
  try {
    return await Promise.race([collection, deadline.timeout]);
  } catch (error) {
    const errorCode = collectorErrorCode(error);
    const diagnostics = { ...failureDiagnostics(context, tab?.id), ...runtime.safeDiagnostics(error?.diagnostics || {}), errorCode };
    const traceStage = errorCode === "SOURCE_COLLECTION_DEADLINE_EXCEEDED" ? "SOURCE_COLLECTION_TIMEOUT" : "COLLECTOR_START_FAILED";
    await recordStartTrace({ requestId, stage: traceStage, status: "FAIL", errorCode, ...diagnostics });
    if (tab?.id) { await chrome.tabs.remove(tab.id).catch(() => {}); tab = null; }
    await failCollectorScan(scanId, error, diagnostics);
    await setCollectorState({ status: "failed", phase: "FAILED", progress: errorCode, errorCode, lastStage: diagnostics.stage, query: diagnostics.query, sourceUrl: PRODUCTION_SOURCE_URL, scanId, finishedAt: new Date().toISOString() });
    return { sourceUrl: PRODUCTION_SOURCE_URL, status: "FAILED", error: errorCode, diagnostics, scanId };
  } finally {
    deadline.cancel();
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function pollCollectorJobs() {
  if (collectorJobPollInFlight) return;
  collectorJobPollInFlight = true;
  try {
    const value = await pairingStorageValue();
    if (!value.apiUrl || !value.deviceId || !value.deviceToken) return;
    const claimed = await signedPost(`${String(value.apiUrl).replace(/\/+$/, "")}/api/collector/jobs/claim`, "{}", 8_000);
    if (!claimed?.job?.id || !claimed.job.leaseToken || !claimed.job.runId) return;
    const requestId = crypto.randomUUID();
    await setCollectorState({ status: "collecting", phase: "CLAIMED", progress: "Collector odebrał zlecenie", scanId: claimed.job.runId, jobId: claimed.job.id });
    const result = await collectConfiguredSources(claimed.job.runId, requestId);
    const completedBody = JSON.stringify({ jobId: claimed.job.id, leaseToken: claimed.job.leaseToken, status: result.status === "FAILED" ? "failed" : "completed", errorCode: result.error || null });
    await signedPost(`${String(value.apiUrl).replace(/\/+$/, "")}/api/collector/jobs/complete`, completedBody, 8_000);
  } finally { collectorJobPollInFlight = false; }
}

async function collectTabSource(tabId, sourceUrl, scanId, requestId = "unknown", collectionContext = null) {
  await recordStartTrace({ requestId, stage: "COLLECTOR_STARTED", status: "PASS" });
  const startedAtMs = Date.now();
  await setCollectorState({ status: "collecting", phase: "MAIN_FEED", progress: PHASE_MAIN_FEED, sourceUrl, scanId, startedAt: new Date().toISOString() });
  const primaryBudgetMs = PRODUCTION_LIMITS.hardTimeBudgetMs - SEARCH_BUDGET_RESERVE_MS;
  updateCollectionContext(collectionContext, "MAIN_FEED", null);
  const primary = await collectFromTab(tabId, { minScrolls: PRODUCTION_LIMITS.minScrolls, maxScrolls: PRODUCTION_LIMITS.maxScrolls, maxPosts: PRODUCTION_LIMITS.maxPosts, budgetMs: primaryBudgetMs, discoverySource: "MAIN_FEED" }, { requestId, source: "lodzsprzedazzakupwynajem", collectionContext });
  let posts = primary.posts;
  const searchRuns = [];
  const mainFeedIds = new Set(primary.posts.map((post) => post.postId));
  const searchStartedAtMs = Date.now();
  let searchBudgetExhausted = false;
  if (primary.source.sourceType === "GROUP") {
    for (let queryIndex = 0; queryIndex < ACTIVE_SEARCH_QUERIES.length; queryIndex += 1) {
      const query = ACTIVE_SEARCH_QUERIES[queryIndex];
      const queryStartedAtMs = Date.now();
      const queryDeadlineMs = Math.min(queryStartedAtMs + SEARCH_LIMITS.hardTimeBudgetPerQueryMs - SEARCH_QUERY_CLEANUP_RESERVE_MS, searchStartedAtMs + SEARCH_LIMITS.hardTimeBudgetMs - SEARCH_QUERY_CLEANUP_RESERVE_MS);
      const searchRemaining = SEARCH_LIMITS.hardTimeBudgetMs - (queryStartedAtMs - searchStartedAtMs);
      if (searchRemaining < 5_000 + SEARCH_BUDGET_SAFETY_MS) {
        searchBudgetExhausted = true;
        appendUnexecutedSearchRuns(searchRuns, queryIndex, "SEARCH_GLOBAL_TIME_BUDGET");
        break;
      }
      if (posts.length >= PRODUCTION_LIMITS.maxPosts) {
        appendUnexecutedSearchRuns(searchRuns, queryIndex, "MERGED_MAX_POSTS");
        break;
      }
      await setCollectorState({ status: "collecting", phase: "SEARCH", query, progress: `Przeszukiwanie: ${query}…`, sourceUrl, scanId, startedAt: new Date(startedAtMs).toISOString() });
      updateCollectionContext(collectionContext, "SEARCH", query);
      const searchUrl = `https://www.facebook.com/groups/${primary.source.sourceId}/search/?q=${encodeURIComponent(query)}`;
      await chrome.tabs.update(tabId, { url: searchUrl });
      try {
        await waitForTab(tabId, Math.min(10_000, searchRemaining));
        collectionContext?.deadline.assertActive(failureDiagnostics(collectionContext, tabId));
        const remainingAfterLoad = SEARCH_LIMITS.hardTimeBudgetMs - (Date.now() - searchStartedAtMs);
        if (remainingAfterLoad < 5_000 + SEARCH_BUDGET_SAFETY_MS) throw new Error("SEARCH_GLOBAL_TIME_BUDGET");
        const queryBudgetMs = Math.min(SEARCH_LIMITS.discoveryBudgetMs, remainingAfterLoad - SEARCH_BUDGET_SAFETY_MS, queryDeadlineMs - Date.now() - SEARCH_BUDGET_SAFETY_MS);
        if (queryBudgetMs < 5_000) throw new Error("SEARCH_QUERY_TIME_BUDGET");
        const search = await collectFromTab(tabId, { minScrolls: SEARCH_LIMITS.minScrolls, maxScrolls: SEARCH_LIMITS.maxScrolls, maxPosts: SEARCH_LIMITS.maxUniquePerQuery, maxMediaTiles: SEARCH_LIMITS.maxTilesToOpen, budgetMs: queryBudgetMs, searchMode: true, discoverySource: "SEARCH", searchQuery: query }, { requestId, source: primary.source.sourceId, collectionContext });
        const tileResolution = await resolveSearchMediaTiles({ tiles: search.mediaTiles, source: primary.source, query, deadlineMs: queryDeadlineMs });
        const queryPosts = globalThis.FlipFacebookCollectorCore.mergeRecords([...search.posts, ...tileResolution.posts], SEARCH_LIMITS.maxUniquePerQuery);
        const beforeIds = new Set(posts.map((post) => post.postId));
        const mergedSearch = mergePosts([...posts, ...queryPosts]);
        const newUnique = mergedSearch.filter((post) => !beforeIds.has(post.postId));
        searchRuns.push(searchTelemetry({ query, search: { ...search, posts: queryPosts }, tileResolution, mainFeedIds, newUnique, durationMs: Date.now() - queryStartedAtMs }));
        posts = mergedSearch.slice(0, PRODUCTION_LIMITS.maxPosts);
      } catch (error) {
        const reason = safeError(error);
        searchRuns.push(failedSearchTelemetry(query, Date.now() - queryStartedAtMs, reason));
        if (reason === "COLLECT_SOURCE_RESPONSE_TIMEOUT" || reason === "SOURCE_COLLECTION_DEADLINE_EXCEEDED") throw error;
        if (reason === "SEARCH_GLOBAL_TIME_BUDGET" || Date.now() - searchStartedAtMs >= SEARCH_LIMITS.hardTimeBudgetMs) {
          searchBudgetExhausted = true;
          appendUnexecutedSearchRuns(searchRuns, queryIndex + 1, "SEARCH_GLOBAL_TIME_BUDGET");
          break;
        }
      }
    }
    if (Date.now() - searchStartedAtMs < SEARCH_LIMITS.hardTimeBudgetMs) {
      await chrome.tabs.update(tabId, { url: primary.source.sourceUrl });
    }
  }
  const searchTelemetrySummary = {
    hardTimeBudgetMs: SEARCH_LIMITS.hardTimeBudgetMs,
    durationMs: Date.now() - searchStartedAtMs,
    queriesPlanned: ACTIVE_SEARCH_QUERIES.length,
    queriesExecuted: searchRuns.filter((run) => run.executed).length,
    budgetExhausted: searchBudgetExhausted || Date.now() - searchStartedAtMs >= SEARCH_LIMITS.hardTimeBudgetMs,
    queries: searchRuns,
  };
  const durationMs = Date.now() - startedAtMs;
  collectionContext?.deadline.assertActive(failureDiagnostics(collectionContext, tabId));
  updateCollectionContext(collectionContext, "FINALIZE", null);
  await setCollectorState({ status: "collecting", phase: "FINALIZE", progress: PHASE_FINALIZE, sourceUrl, scanId, startedAt: new Date(startedAtMs).toISOString() });
  const health = healthAfterSearch(primary.health, posts.length, searchTelemetrySummary, durationMs);
  const duplicateCount = primary.posts.length + searchRuns.reduce((sum, run) => sum + run.captured, 0) - posts.length;
  const identity = { verified: posts.filter((post) => post.identityConfidence === "EXACT").length, unverified: posts.filter((post) => post.identityConfidence !== "EXACT").length, conflictsBlocked: posts.filter((post) => (post.identityReasons || []).includes("POST_IDENTITY_CONFLICT")).length };
  const images = { rawCandidates: posts.reduce((sum, post) => sum + (post.media || []).length, 0), verifiedProvenance: posts.reduce((sum, post) => sum + (post.media || []).filter((media) => media.exactAssociation === true && media.exactPostId === post.postId).length, 0), imported: 0 };
  const targets = ["1577700267381450", "1578068947344582", "1577710350713775"];
  collectionContext?.deadline.assertActive(failureDiagnostics(collectionContext, tabId));
  const batch = { scanId, batchId: crypto.randomUUID(), sourceId: primary.source.sourceId, sourceType: primary.source.sourceType, sourceUrl: primary.source.sourceUrl, collectedAt: new Date().toISOString(), health, searchTelemetry: searchTelemetrySummary, posts };
  await recordStartTrace({ requestId, stage: "COLLECTOR_BATCH_CREATED", status: "PASS" });
  const upload = await uploadBatch(batch);
  images.imported = upload?.listingsCreated ? images.verifiedProvenance : 0;
  const result = { scanId, sourceUrl: primary.source.sourceUrl, sourceId: primary.source.sourceId, health, captured: posts.length, searchFallbackUsed: searchRuns.some((run) => run.executed), upload, mainFeed: { captured: primary.posts.length, unique: primary.posts.length, scrolls: primary.health.scrolls, durationMs: primary.health.durationMs, stopReason: primary.health.stopReason }, search: searchRuns, searchTelemetry: searchTelemetrySummary, merged: { totalCaptured: primary.posts.length + searchRuns.reduce((sum, run) => sum + run.captured, 0), totalUnique: posts.length, duplicatesRemoved: Math.max(0, duplicateCount) }, identity, images, targetsFound: targets.filter((target) => posts.some((post) => post.postId === target)), iterations: primary.iterations, finishedAt: new Date().toISOString() };
  await chrome.storage.local.set({ collectorLastResult: result, collectorState: { status: "idle", phase: "DONE", progress: PHASE_DONE, scanId, finishedAt: result.finishedAt } });
  return result;
}

async function collectFromTab(tabId, options, traceContext = {}) {
  await waitForContentScript(tabId);
  const runtime = globalThis.FlipCollectorRuntime;
  const collectionContext = traceContext.collectionContext;
  const query = options.searchQuery || "MAIN_FEED";
  const diagnostics = { query, tabId, source: traceContext.source || "facebook", stage: options.searchMode ? "SEARCH_COLLECT_SOURCE" : "MAIN_FEED_COLLECT_SOURCE" };
  collectionContext?.deadline.assertActive(diagnostics);
  const desiredTimeoutMs = options.searchMode
    ? COLLECT_SOURCE_RESPONSE_MIN_TIMEOUT_MS
    : Math.max(COLLECT_SOURCE_RESPONSE_MIN_TIMEOUT_MS, Number(options.budgetMs || 0) + COLLECT_SOURCE_RESPONSE_GRACE_MS);
  const remainingMs = collectionContext?.deadline.remainingMs() ?? desiredTimeoutMs;
  const timeoutMs = Math.max(1, Math.min(desiredTimeoutMs, remainingMs));
  const timeoutCode = remainingMs <= desiredTimeoutMs ? "SOURCE_COLLECTION_DEADLINE_EXCEEDED" : "COLLECT_SOURCE_RESPONSE_TIMEOUT";
  const sentAt = Date.now();
  await recordStartTrace({ requestId: traceContext.requestId, stage: "COLLECT_SOURCE_SENT", status: "PASS", ...diagnostics });
  let responseResult;
  try {
    responseResult = await runtime.sendMessageWithTimeout(
      () => chrome.tabs.sendMessage(tabId, { type: "COLLECT_SOURCE", options }),
      { timeoutMs, timeoutCode, diagnostics },
    );
  } catch (error) {
    const errorCode = collectorErrorCode(error);
    await recordStartTrace({ requestId: traceContext.requestId, stage: "COLLECT_SOURCE_TIMEOUT", status: "TIMEOUT", errorCode, ...diagnostics, elapsedMs: Date.now() - sentAt });
    throw error;
  }
  const response = responseResult.response;
  await recordStartTrace({ requestId: traceContext.requestId, stage: "COLLECT_SOURCE_RESPONSE", status: "PASS", ...diagnostics, elapsedMs: responseResult.elapsedMs });
  if (!response?.ok) throw new Error(response?.error || "COLLECT_SOURCE_FAILED");
  return response.result;
}

async function resolveSearchMediaTiles({ tiles, source, query, deadlineMs }) {
  const uniqueTiles = [...new Map((Array.isArray(tiles) ? tiles : []).filter((tile) => /^\d{5,30}$/.test(String(tile?.mediaId || "")) && typeof tile?.photoUrl === "string").map((tile) => [String(tile.mediaId), tile])).values()];
  const selected = uniqueTiles.slice(0, SEARCH_LIMITS.maxTilesToOpen);
  const parentPosts = new Map();
  const resolvedRecords = [];
  let tilesOpened = 0;
  let duplicatesByMedia = 0;
  let nextTileIndex = 0;
  let deadlineReached = false;
  async function resolveWorker() {
    while (nextTileIndex < selected.length) {
      if (deadlineMs - Date.now() < 1_000) { deadlineReached = true; return; }
      const tile = selected[nextTileIndex];
      nextTileIndex += 1;
      let resolverTabId = null;
      try {
        resolverTabId = (await chrome.tabs.create({ url: tile.photoUrl, active: false })).id;
        if (!resolverTabId) throw new Error("SEARCH_MEDIA_RESOLVER_TAB_MISSING");
        tilesOpened += 1;
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs < 500) { deadlineReached = true; return; }
        await waitForTab(resolverTabId, Math.min(4_000, remainingMs));
        const contentRemainingMs = deadlineMs - Date.now();
        if (contentRemainingMs < 250) { deadlineReached = true; return; }
        await waitForContentScript(resolverTabId, Math.min(4_000, contentRemainingMs));
        if (deadlineMs - Date.now() < 100) { deadlineReached = true; return; }
        const response = await chrome.tabs.sendMessage(resolverTabId, { type: "RESOLVE_SEARCH_MEDIA_TILE", options: { mediaId: tile.mediaId, sourceUrl: source.sourceUrl, searchQuery: query } });
        const records = response?.ok && response.result?.status === "VERIFIED" && Array.isArray(response.result.records) ? response.result.records : [];
        if (records.length === 1 && records[0].identityConfidence === "EXACT" && records[0].resolvedFromMediaTile === true) resolvedRecords.push({ ...records[0], media: [] });
      } catch { /* an individual tile remains UNVERIFIED */ }
      finally { if (resolverTabId !== null) await chrome.tabs.remove(resolverTabId).catch(() => {}); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEARCH_LIMITS.tileConcurrency, selected.length) }, () => resolveWorker()));
  for (const record of resolvedRecords) {
    if (parentPosts.size >= SEARCH_LIMITS.maxUniquePerQuery && !parentPosts.has(record.postId)) continue;
    if (parentPosts.has(record.postId)) duplicatesByMedia += 1;
    const [merged] = globalThis.FlipFacebookCollectorCore.mergeRecords([parentPosts.get(record.postId), record].filter(Boolean), 1);
    parentPosts.set(record.postId, merged);
  }
  const posts = [...parentPosts.values()];
  const tilesSeen = uniqueTiles.length;
  const tilesResolved = posts.reduce((sum, post) => sum + Math.max(1, post.mediaIds?.length || 0), 0);
  const tilesUnverified = Math.max(0, tilesOpened - tilesResolved);
  const expectedOpens = Math.min(tilesSeen, SEARCH_LIMITS.maxTilesToOpen);
  return { posts, tilesSeen, tilesOpened, tilesResolved, tilesUnverified, uniqueParentPosts: posts.length, verifiedParentPosts: posts.length, duplicatesByMedia, budgetExhausted: deadlineReached || ((tilesOpened < expectedOpens || tilesUnverified > 0) && Date.now() >= deadlineMs) };
}

async function uploadBatch(batch) {
  const config = await configValue();
  if (!config.apiUrl || !config.deviceId || !config.deviceToken) return { status: "LOCAL_ONLY", reason: "COLLECTOR_NOT_PAIRED" };
  const apiUrl = String(config.apiUrl).replace(/\/+$/, "");
  try {
    await signedPost(`${apiUrl}/api/collector/heartbeat`, "{}");
    await persistPairingVerification(config, { kind: "VALID" });
  } catch (error) {
    await persistPairingVerification(config, verificationOutcome(error));
    throw error;
  }
  return signedPost(`${apiUrl}/api/collector/facebook/batches`, JSON.stringify(batch));
}

async function checkCollectorReady(requestId = "unknown") {
  const value = await pairingStorageValue();
  const local = globalThis.FlipCollectorPairingStatus.localPairingStatus(value);
  if (local.status === "DISCONNECTED" || local.status === "RECONNECT_REQUIRED") {
    await recordStartTrace({ requestId, stage: "EXTENSION_READY_RESULT", status: "FAIL", errorCode: local.status === "DISCONNECTED" ? "PAIRING_MISSING" : "PAIRING_RECONNECT_REQUIRED" });
    return { ok: false, status: local.status, label: local.label, error: local.status === "DISCONNECTED" ? "PAIRING_MISSING" : "PAIRING_RECONNECT_REQUIRED" };
  }
  try {
    await signedPost(`${String(value.apiUrl).replace(/\/+$/, "")}/api/collector/heartbeat`, "{}");
    const verified = await persistPairingVerification(value, { kind: "VALID" });
    await recordStartTrace({ requestId, stage: "EXTENSION_READY_RESULT", status: "PASS" });
    return { ok: true, status: verified.status, label: verified.label, lastHeartbeatAt: verified.lastHeartbeatAt, health: verified.health };
  } catch (error) {
    const verified = await persistPairingVerification(value, verificationOutcome(error));
    await recordStartTrace({ requestId, stage: "EXTENSION_READY_RESULT", status: "FAIL", errorCode: verified.reason || safeError(error) });
    return { ok: false, status: verified.status, label: verified.label, error: verified.reason || safeError(error) };
  }
}

async function refreshCollectorHealth(requestId) {
  const result = await globalThis.FlipCollectorStartPreflight.refreshCollectorHealth({
    requestId,
    readPairing: pairingStorageValue,
    localPairingStatus: globalThis.FlipCollectorPairingStatus.localPairingStatus,
    heartbeat: async (timeoutMs) => {
      const value = await pairingStorageValue();
      await signedPost(`${String(value.apiUrl).replace(/\/+$/, "")}/api/collector/heartbeat`, "{}", timeoutMs);
    },
    persistVerification: persistPairingVerification,
    verificationOutcome,
    trace: (id, stage, status, errorCode) => recordStartTrace({ requestId: id, stage, status, errorCode }),
  });
  await recordStartTrace({ requestId, stage: "HEALTH_REFRESH_RESPONSE", status: result.ok ? "PASS" : "FAIL", errorCode: result.ok ? undefined : result.error }).catch(() => {});
  return result;
}

async function validateCollector(requestId) {
  const validation = { ok: false, pairing: { ok: false }, heartbeat: { ok: false }, backendReadiness: { ok: false }, backgroundToContentScript: { ok: false }, contentScriptResponse: { ok: false }, firstFailedHop: null, error: null };
  const value = await pairingStorageValue();
  const local = globalThis.FlipCollectorPairingStatus.localPairingStatus(value);
  validation.pairing = { ok: local.status === "CONNECTED" || local.status === "UNVERIFIED", deviceIdPresent: Boolean(value.deviceId), tokenPresent: Boolean(value.deviceToken), status: local.status };
  if (!validation.pairing.ok) { validation.firstFailedHop = "PAIRING"; validation.error = local.status === "DISCONNECTED" ? "PAIRING_MISSING" : "PAIRING_RECONNECT_REQUIRED"; return validation; }

  const health = await refreshCollectorHealth(requestId);
  validation.heartbeat = { ok: health.ok && health.heartbeatUpdated === true, lastHeartbeatAt: health.lastHeartbeatAt || null, health: health.health || null };
  if (!validation.heartbeat.ok) { validation.firstFailedHop = "HEARTBEAT"; validation.error = health.error || "COLLECTOR_HEALTH_REFRESH_FAILED"; return validation; }

  try {
    const config = await configValue();
    const readiness = await signedPost(`${String(config.apiUrl).replace(/\/+$/, "")}/api/collector/readiness`, "{}", 3_000);
    validation.backendReadiness = { ok: readiness?.ok === true && readiness?.ready === true, lastHeartbeatAt: typeof readiness?.lastHeartbeatAt === "string" ? readiness.lastHeartbeatAt : null, health: typeof readiness?.health === "string" ? readiness.health : null };
  } catch (error) {
    validation.backendReadiness = { ok: false };
    validation.firstFailedHop = "BACKEND_READINESS";
    validation.error = safeError(error) || "COLLECTOR_READINESS_UNAVAILABLE";
    return validation;
  }
  if (!validation.backendReadiness.ok) { validation.firstFailedHop = "BACKEND_READINESS"; validation.error = "COLLECTOR_NOT_READY"; return validation; }

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: PRODUCTION_SOURCE_URL, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error("FACEBOOK_TEST_TAB_CREATE_FAILED");
    await waitForTab(tabId, 10_000);
    await waitForContentScript(tabId, 10_000);
    validation.backgroundToContentScript = { ok: true };
    const response = await globalThis.FlipCollectorRuntime.sendMessageWithTimeout(
      () => chrome.tabs.sendMessage(tabId, { type: "COLLECTOR_SELF_TEST", requestId }),
      { timeoutMs: 10_000, timeoutCode: "CONTENT_SCRIPT_RESPONSE_TIMEOUT", diagnostics: { tabId, source: "facebook" } },
    );
    const selfTest = response.response;
    validation.contentScriptResponse = { ok: selfTest?.ok === true && selfTest?.requestId === requestId, requestId: selfTest?.requestId === requestId ? requestId : null, href: typeof selfTest?.href === "string" ? selfTest.href.slice(0, 300) : null, documentReadyState: typeof selfTest?.documentReadyState === "string" ? selfTest.documentReadyState : null, collectorVersion: typeof selfTest?.collectorVersion === "string" ? selfTest.collectorVersion : null };
    if (!validation.contentScriptResponse.ok) { validation.firstFailedHop = "CONTENT_SCRIPT_RESPONSE"; validation.error = "CONTENT_SCRIPT_SELF_TEST_FAILED"; return validation; }
  } catch (error) {
    if (!validation.backgroundToContentScript.ok) validation.firstFailedHop = "BACKGROUND_TO_CONTENT_SCRIPT";
    else validation.firstFailedHop = "CONTENT_SCRIPT_RESPONSE";
    validation.error = safeError(error) || "CONTENT_SCRIPT_RESPONSE_TIMEOUT";
    return validation;
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => {});
  }
  validation.ok = true;
  return validation;
}

async function failCollectorScan(scanId, error, diagnostics = {}) {
  const config = await configValue();
  if (!config.apiUrl || !config.deviceId || !config.deviceToken) return;
  try {
    await signedPost(`${String(config.apiUrl).replace(/\/+$/, "")}/api/collector/facebook/scans/${scanId}/fail`, JSON.stringify({ error: collectorErrorCode(error), ...globalThis.FlipCollectorRuntime.safeDiagnostics(diagnostics) }), FAIL_REPORT_TIMEOUT_MS);
  } catch { /* preserve the original collector failure */ }
}

async function signedPost(urlValue, body, timeoutMs = null) {
  const config = await configValue();
  const url = new URL(urlValue);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const canonical = `${timestamp}\n${nonce}\nPOST\n${url.pathname}\n${bodyHash}`;
  const signingKeyHex = await sha256Hex(config.deviceToken);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKeyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  const response = await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json", "X-Flip-Collector-Device-Id": config.deviceId, "X-Flip-Collector-Timestamp": timestamp, "X-Flip-Collector-Nonce": nonce, "X-Flip-Collector-Signature": signature }, body, ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`COLLECTOR_UPLOAD_${response.status}:${payload.code || "FAILED"}`);
  return payload;
}

function healthAfterSearch(primary, captured, searchTelemetrySummary, durationMs) {
  const searchRuns = searchTelemetrySummary.queries;
  if (!searchRuns.some((run) => run.executed) && durationMs === primary.durationMs) return primary;
  const improved = captured > primary.capturedPostCount;
  const reasons = improved ? primary.reasons.filter((reason) => !["COLLECTOR_LOW_CAPTURE_COUNT", "COLLECTOR_LOW_CAPTURE_RATIO", "COLLECTOR_GROWING_FEED_WITHOUT_NEW_IDS"].includes(reason)) : primary.reasons;
  if (searchTelemetrySummary.budgetExhausted) reasons.push("COLLECTOR_SEARCH_GLOBAL_TIME_BUDGET");
  if (searchRuns.some((run) => run.executed && run.status === "FAILED")) reasons.push("COLLECTOR_SEARCH_QUERY_FAILED");
  if (searchRuns.some((run) => run.executed && run.status === "DEGRADED")) reasons.push("COLLECTOR_SEARCH_QUERY_DEGRADED");
  const stopReason = searchTelemetrySummary.budgetExhausted ? "SEARCH_GLOBAL_TIME_BUDGET" : improved ? "SEARCH_FALLBACK_COMPLETED" : primary.stopReason;
  return { ...primary, status: reasons.length ? "DEGRADED" : "HEALTHY", capturedPostCount: captured, captureRatio: primary.visibleCardCount ? Math.min(1, captured / primary.visibleCardCount) : captured ? 1 : 0, durationMs, stopReason, reasons: [...new Set(reasons)] };
}

function searchTelemetry({ query, search, tileResolution, mainFeedIds, newUnique, durationMs }) {
  const incompleteTiles = tileResolution.tilesOpened < Math.min(tileResolution.tilesSeen, SEARCH_LIMITS.maxTilesToOpen) || tileResolution.tilesUnverified > 0;
  const status = search.health.status === "FAILED" ? "FAILED" : incompleteTiles || tileResolution.budgetExhausted ? "DEGRADED" : search.posts.length || tileResolution.tilesSeen === 0 ? "HEALTHY" : "DEGRADED";
  return { query, executed: true, status, scrolls: search.health.scrolls, visibleCards: search.health.visibleCardCount, captured: search.posts.length, unique: search.posts.length, duplicatesVsMainFeed: search.posts.filter((post) => mainFeedIds.has(post.postId)).length, uniqueContribution: newUnique.length, sellContribution: newUnique.filter(isLikelySellText).length, tilesSeen: tileResolution.tilesSeen, tilesOpened: tileResolution.tilesOpened, tilesResolved: tileResolution.tilesResolved, tilesUnverified: tileResolution.tilesUnverified, uniqueParentPosts: tileResolution.uniqueParentPosts, verifiedParentPosts: tileResolution.verifiedParentPosts, duplicatesByMedia: tileResolution.duplicatesByMedia, durationMs, stopReason: tileResolution.budgetExhausted ? "SEARCH_QUERY_TIME_BUDGET" : search.health.stopReason };
}
function failedSearchTelemetry(query, durationMs, stopReason) { return { query, executed: true, status: "FAILED", scrolls: 0, visibleCards: 0, captured: 0, unique: 0, duplicatesVsMainFeed: 0, uniqueContribution: 0, sellContribution: 0, tilesSeen: 0, tilesOpened: 0, tilesResolved: 0, tilesUnverified: 0, uniqueParentPosts: 0, verifiedParentPosts: 0, duplicatesByMedia: 0, durationMs, stopReason }; }
function appendUnexecutedSearchRuns(searchRuns, fromIndex, stopReason) { for (const query of ACTIVE_SEARCH_QUERIES.slice(fromIndex)) searchRuns.push({ query, executed: false, status: "DEGRADED", scrolls: 0, visibleCards: 0, captured: 0, unique: 0, duplicatesVsMainFeed: 0, uniqueContribution: 0, sellContribution: 0, tilesSeen: 0, tilesOpened: 0, tilesResolved: 0, tilesUnverified: 0, uniqueParentPosts: 0, verifiedParentPosts: 0, duplicatesByMedia: 0, durationMs: 0, stopReason }); }

function mergePosts(posts) {
  return globalThis.FlipFacebookCollectorCore.mergeRecords(posts, PRODUCTION_LIMITS.maxPosts);
}
function isLikelySellText(post) { return /\b(?:sprzedam|na\s+sprzeda[zż]|do\s+sprzedania|off\s*market|mam\s+do\s+zaoferowania)\b/i.test(String(post?.text || "")); }
async function setCollectorState(state) { await chrome.storage.local.set({ collectorState: { ...state } }).catch(() => {}); }
async function configValue() { return chrome.storage.local.get(["apiUrl", "deviceId", "deviceToken", "sources"]); }
async function pairingStorageValue() { return chrome.storage.local.get(["apiUrl", "deviceId", "deviceToken", "collectorPairingState", "collectorLastResult"]); }
async function getPairingStatus() { return globalThis.FlipCollectorPairingStatus.localPairingStatus(await pairingStorageValue()); }
let pairingVerification = null;
async function verifyPairingStatus() {
  if (pairingVerification) return pairingVerification;
  pairingVerification = verifyPairingStatusOnce().finally(() => { pairingVerification = null; });
  return pairingVerification;
}
async function verifyPairingStatusOnce() {
  const value = await pairingStorageValue();
  const local = globalThis.FlipCollectorPairingStatus.localPairingStatus(value);
  if (local.status === "DISCONNECTED" || local.status === "RECONNECT_REQUIRED") return local;
  try {
    const apiUrl = String(value.apiUrl).replace(/\/+$/, "");
    await signedPost(`${apiUrl}/api/collector/heartbeat`, "{}");
    return persistPairingVerification(value, { kind: "VALID" });
  } catch (error) {
    return persistPairingVerification(value, verificationOutcome(error));
  }
}
async function persistPairingVerification(value, outcome) {
  const result = globalThis.FlipCollectorPairingStatus.verifiedPairingStatus({ ...value, collectorLastResult: (await chrome.storage.local.get("collectorLastResult")).collectorLastResult }, outcome);
  if (result.storageState) await chrome.storage.local.set({ collectorPairingState: result.storageState });
  return { status: result.status, label: result.label, shouldVerify: result.shouldVerify, deviceLabel: result.deviceLabel, verifiedAt: result.verifiedAt, lastHeartbeatAt: result.lastHeartbeatAt, lastSuccessfulScanAt: result.lastSuccessfulScanAt, health: result.health, reason: result.reason };
}
function verificationOutcome(error) { const message = safeError(error); return /^COLLECTOR_UPLOAD_(?:401|403):/.test(message) ? { kind: "REVOKED", reason: message.split(":").at(-1) } : { kind: "TEMPORARY_FAILURE", reason: message }; }
async function recordStartTrace(message) {
  const requestId = safeRequestId(message.requestId);
  if (requestId === "unknown") return;
  const stored = await chrome.storage.local.get("collectorStartTraces");
  const traces = stored.collectorStartTraces && typeof stored.collectorStartTraces === "object" ? stored.collectorStartTraces : {};
  const trace = Array.isArray(traces[requestId]) ? traces[requestId] : [];
  const diagnostics = globalThis.FlipCollectorRuntime?.safeDiagnostics(message) || {};
  trace.push({ requestId, stage: String(message.stage || "UNKNOWN").slice(0, 80), timestamp: new Date().toISOString(), status: ["PASS", "FAIL", "TIMEOUT"].includes(message.status) ? message.status : "PASS", ...(typeof message.errorCode === "string" ? { errorCode: message.errorCode.replace(/token|secret|cookie|hmac/gi, "redacted").slice(0, 120) } : {}), ...diagnostics });
  traces[requestId] = trace.slice(-80);
  const keys = Object.keys(traces).slice(-50);
  await chrome.storage.local.set({ collectorStartTraces: Object.fromEntries(keys.map((key) => [key, traces[key]])) });
}
function safeRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "unknown"; }
function isUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function collectorErrorCode(error) { return typeof error?.code === "string" ? error.code.slice(0, 120) : safeError(error).split(":", 1)[0]; }
function updateCollectionContext(context, stage, query) { if (!context) return; context.lastStage = stage; context.query = query; }
function failureDiagnostics(context, tabId) { return { stage: context?.lastStage || "SOURCE_COLLECTION", query: context?.query || undefined, tabId, source: context?.source || "facebook", elapsedMs: context?.deadline ? Date.now() - context.deadline.startedAt : undefined }; }
async function waitForTab(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url && !/\/login|\/checkpoint/i.test(tab.url)) return;
    await wait(250);
  }
  throw new Error("FACEBOOK_TAB_LOAD_TIMEOUT");
}
async function waitForContentScript(tabId, timeoutMs = 10_000) {
  let injected = false;
  let lastError = null;
  const attempts = Math.max(1, Math.ceil(timeoutMs / 250));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { const response = await chrome.tabs.sendMessage(tabId, { type: "COLLECTOR_PING" }); if (response) return; } catch (error) { lastError = `${lastError || ""}|${safeError(error)}`.slice(-800); }
    if (!injected && attempt === Math.min(10, Math.max(1, Math.floor(attempts / 2)))) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["collector-core.js", "content.js"] });
        injected = true;
      } catch (error) { lastError = safeError(error); }
    }
    await wait(250);
  }
  throw new Error(`COLLECTOR_CONTENT_SCRIPT_UNAVAILABLE:${lastError || "UNKNOWN"}`);
}
async function sha256Hex(value) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
function hex(buffer) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function isProductionSource(value) { try { const url = new URL(value); url.search = ""; url.hash = ""; url.pathname = `${url.pathname.replace(/\/+$/, "")}/`; return url.protocol === "https:" && url.hostname === "www.facebook.com" && url.toString() === PRODUCTION_SOURCE_URL; } catch { return false; } }
function isAllowedExternalSender(sender) { try { const url = new URL(String(sender?.url || "")); return (url.origin === FINDER_ORIGIN || url.origin === "http://localhost:3000") && (url.pathname === "/" || url.pathname.startsWith("/flip-finder")); } catch { return false; } }
function isFinderUrl(value) { try { const url = new URL(String(value || "")); return url.origin === FINDER_ORIGIN && url.pathname.startsWith("/flip-finder"); } catch { return false; } }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error) { return error instanceof Error ? error.message.slice(0, 400) : "COLLECTOR_FAILED"; }
