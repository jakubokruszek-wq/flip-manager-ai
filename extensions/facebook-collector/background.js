"use strict";

importScripts("collector-core.js");

const PRODUCTION_SOURCE_URL = "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/";
const PRODUCTION_LIMITS = { maxPosts: 50, minScrolls: 5, maxScrolls: 30, hardTimeBudgetMs: 110_000 };
const SEARCH_BUDGET_RESERVE_MS = 40_000;
const SEARCH_QUERY_BUDGET_MS = 6_000;

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
const ACTIVE_SEARCH_QUERIES = ["sprzedam", "na sprzeda\u017c", "mieszkanie", "\u0141\u00f3d\u017a", "2 pokoje", "3 pokoje"];
const PHASE_MAIN_FEED = "Skanowanie feedu\u2026";
const PHASE_FINALIZE = "Scalanie wynikow i analiza ofert\u2026";
const PHASE_DONE = "Zakonczono";

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === "COLLECT_ACTIVE_SOURCE") {
    void collectActiveSource().then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (message?.type === "COLLECT_CONFIGURED_SOURCES") {
    void collectConfiguredSources().then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  }
  if (message?.type === "GET_COLLECTOR_STATE") {
    void chrome.storage.local.get(["collectorState", "collectorLastResult"]).then(respond);
    return true;
  }
  if (message?.type === "SAVE_PAIRING_CONFIG" && message.config) {
    void chrome.storage.local.set({ apiUrl: message.config.apiUrl, deviceId: message.config.deviceId, deviceToken: message.config.deviceToken }).then(() => respond({ ok: true }));
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

async function collectConfiguredSources() {
  const scanId = crypto.randomUUID();
  let tab;
  try {
    tab = await chrome.tabs.create({ url: PRODUCTION_SOURCE_URL, active: false });
    await waitForTab(tab.id, 30_000);
    return await collectTabSource(tab.id, PRODUCTION_SOURCE_URL, scanId);
  } catch (error) {
    return { sourceUrl: PRODUCTION_SOURCE_URL, status: "FAILED", error: safeError(error) };
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collectTabSource(tabId, sourceUrl, scanId) {
  const startedAtMs = Date.now();
  await setCollectorState({ status: "collecting", phase: "MAIN_FEED", progress: PHASE_MAIN_FEED, sourceUrl, startedAt: new Date().toISOString() });
  const primaryBudgetMs = PRODUCTION_LIMITS.hardTimeBudgetMs - SEARCH_BUDGET_RESERVE_MS;
  const primary = await collectFromTab(tabId, { minScrolls: PRODUCTION_LIMITS.minScrolls, maxScrolls: PRODUCTION_LIMITS.maxScrolls, maxPosts: PRODUCTION_LIMITS.maxPosts, budgetMs: primaryBudgetMs, discoverySource: "MAIN_FEED" });
  let posts = primary.posts;
  const searchRuns = [];
  if (primary.source.sourceType === "GROUP") {
    for (const query of ACTIVE_SEARCH_QUERIES) {
      const remaining = PRODUCTION_LIMITS.hardTimeBudgetMs - (Date.now() - startedAtMs);
      if (remaining < 5_000 || posts.length >= PRODUCTION_LIMITS.maxPosts) break;
      await setCollectorState({ status: "collecting", phase: "SEARCH", query, progress: `Przeszukiwanie: ${query}…`, sourceUrl, startedAt: new Date(startedAtMs).toISOString() });
      const searchUrl = `https://www.facebook.com/groups/${primary.source.sourceId}/search/?q=${encodeURIComponent(query)}`;
      await chrome.tabs.update(tabId, { url: searchUrl });
      try {
        await waitForTab(tabId, Math.min(20_000, remaining));
        const search = await collectFromTab(tabId, { minScrolls: 1, maxScrolls: 2, maxPosts: PRODUCTION_LIMITS.maxPosts, budgetMs: Math.min(SEARCH_QUERY_BUDGET_MS, remaining), searchMode: true, discoverySource: "SEARCH", searchQuery: query });
        const beforeIds = new Set(posts.map((post) => post.postId));
        const mergedSearch = mergePosts([...posts, ...search.posts]);
        searchRuns.push({ query, captured: search.posts.length, uniqueContribution: mergedSearch.filter((post) => !beforeIds.has(post.postId)).length, sellContribution: search.posts.filter(isLikelySellText).length, durationMs: search.health.durationMs, health: search.health });
        posts = mergedSearch.slice(0, PRODUCTION_LIMITS.maxPosts);
      } catch (error) {
        searchRuns.push({ query, captured: 0, uniqueContribution: 0, sellContribution: 0, durationMs: Date.now() - (startedAtMs + (PRODUCTION_LIMITS.hardTimeBudgetMs - remaining)), health: { status: "FAILED", reasons: [safeError(error)] } });
      }
    }
    if (Date.now() - startedAtMs < PRODUCTION_LIMITS.hardTimeBudgetMs) {
      await chrome.tabs.update(tabId, { url: primary.source.sourceUrl });
    }
  }
  const durationMs = Date.now() - startedAtMs;
  await setCollectorState({ status: "collecting", phase: "FINALIZE", progress: PHASE_FINALIZE, sourceUrl, startedAt: new Date(startedAtMs).toISOString() });
  const health = healthAfterSearch(primary.health, posts.length, searchRuns, durationMs);
  const duplicateCount = primary.posts.length + searchRuns.reduce((sum, run) => sum + run.captured, 0) - posts.length;
  const identity = { verified: posts.filter((post) => post.identityConfidence === "EXACT").length, unverified: posts.filter((post) => post.identityConfidence !== "EXACT").length, conflictsBlocked: posts.filter((post) => (post.identityReasons || []).includes("POST_IDENTITY_CONFLICT")).length };
  const images = { rawCandidates: posts.reduce((sum, post) => sum + (post.media || []).length, 0), verifiedProvenance: posts.reduce((sum, post) => sum + (post.media || []).filter((media) => media.exactAssociation === true && media.exactPostId === post.postId).length, 0), imported: 0 };
  const targets = ["1577700267381450", "1578068947344582", "1577710350713775"];
  const batch = { scanId, batchId: crypto.randomUUID(), sourceId: primary.source.sourceId, sourceType: primary.source.sourceType, sourceUrl: primary.source.sourceUrl, collectedAt: new Date().toISOString(), health, posts };
  const upload = await uploadBatch(batch);
  images.imported = upload?.listingsCreated ? images.verifiedProvenance : 0;
  const result = { scanId, sourceUrl: primary.source.sourceUrl, sourceId: primary.source.sourceId, health, captured: posts.length, searchFallbackUsed: searchRuns.length > 0, upload, mainFeed: { captured: primary.posts.length, unique: primary.posts.length, scrolls: primary.health.scrolls, durationMs: primary.health.durationMs, stopReason: primary.health.stopReason }, search: searchRuns, merged: { totalCaptured: primary.posts.length + searchRuns.reduce((sum, run) => sum + run.captured, 0), totalUnique: posts.length, duplicatesRemoved: Math.max(0, duplicateCount) }, identity, images, targetsFound: targets.filter((target) => posts.some((post) => post.postId === target)), iterations: primary.iterations, finishedAt: new Date().toISOString() };
  await chrome.storage.local.set({ collectorLastResult: result, collectorState: { status: "idle", phase: "DONE", progress: PHASE_DONE, finishedAt: result.finishedAt } });
  return result;
}

async function collectFromTab(tabId, options) {
  await waitForContentScript(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type: "COLLECT_SOURCE", options });
  if (!response?.ok) throw new Error(response?.error || "COLLECT_SOURCE_FAILED");
  return response.result;
}

async function uploadBatch(batch) {
  const config = await configValue();
  if (!config.apiUrl || !config.deviceId || !config.deviceToken) return { status: "LOCAL_ONLY", reason: "COLLECTOR_NOT_PAIRED" };
  const apiUrl = String(config.apiUrl).replace(/\/+$/, "");
  await signedPost(`${apiUrl}/api/collector/heartbeat`, "{}");
  return signedPost(`${apiUrl}/api/collector/facebook/batches`, JSON.stringify(batch));
}

async function signedPost(urlValue, body) {
  const config = await configValue();
  const url = new URL(urlValue);
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyHash = await sha256Hex(body);
  const canonical = `${timestamp}\n${nonce}\nPOST\n${url.pathname}\n${bodyHash}`;
  const signingKeyHex = await sha256Hex(config.deviceToken);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKeyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  const response = await fetch(url.toString(), { method: "POST", headers: { "Content-Type": "application/json", "X-Flip-Collector-Device-Id": config.deviceId, "X-Flip-Collector-Timestamp": timestamp, "X-Flip-Collector-Nonce": nonce, "X-Flip-Collector-Signature": signature }, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`COLLECTOR_UPLOAD_${response.status}:${payload.code || "FAILED"}`);
  return payload;
}

function healthAfterSearch(primary, captured, searchRuns, durationMs) {
  if (!searchRuns.length && durationMs === primary.durationMs) return primary;
  const improved = captured > primary.capturedPostCount;
  const reasons = improved ? primary.reasons.filter((reason) => !["COLLECTOR_LOW_CAPTURE_COUNT", "COLLECTOR_LOW_CAPTURE_RATIO", "COLLECTOR_GROWING_FEED_WITHOUT_NEW_IDS"].includes(reason)) : primary.reasons;
  if (durationMs >= PRODUCTION_LIMITS.hardTimeBudgetMs) reasons.push("COLLECTOR_HARD_TIME_BUDGET");
  return { ...primary, status: reasons.length ? "DEGRADED" : "HEALTHY", capturedPostCount: captured, captureRatio: primary.visibleCardCount ? Math.min(1, captured / primary.visibleCardCount) : captured ? 1 : 0, durationMs, stopReason: improved ? "SEARCH_FALLBACK_COMPLETED" : primary.stopReason, reasons: [...new Set(reasons)] };
}

function mergePosts(posts) {
  return globalThis.FlipFacebookCollectorCore.mergeRecords(posts, PRODUCTION_LIMITS.maxPosts);
}
function isLikelySellText(post) { return /\b(?:sprzedam|na\s+sprzedaz|do\s+sprzedania|off\s*market|mam\s+do\s+zaoferowania)\b/i.test(String(post?.text || "")); }
async function setCollectorState(state) { await chrome.storage.local.set({ collectorState: { ...state } }).catch(() => {}); }
async function configValue() { return chrome.storage.local.get(["apiUrl", "deviceId", "deviceToken", "sources"]); }
async function waitForTab(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url && !/\/login|\/checkpoint/i.test(tab.url)) return;
    await wait(250);
  }
  throw new Error("FACEBOOK_TAB_LOAD_TIMEOUT");
}
async function waitForContentScript(tabId) {
  let injected = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { const response = await chrome.tabs.sendMessage(tabId, { type: "COLLECTOR_PING" }); if (response) return; } catch { /* loading */ }
    if (!injected && attempt === 10) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["collector-core.js", "content.js"] });
        injected = true;
      } catch { /* restricted page or injection race; continue bounded polling */ }
    }
    await wait(250);
  }
  throw new Error("COLLECTOR_CONTENT_SCRIPT_UNAVAILABLE");
}
async function sha256Hex(value) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
function hex(buffer) { return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function isProductionSource(value) { try { const url = new URL(value); url.search = ""; url.hash = ""; url.pathname = `${url.pathname.replace(/\/+$/, "")}/`; return url.protocol === "https:" && url.hostname === "www.facebook.com" && url.toString() === PRODUCTION_SOURCE_URL; } catch { return false; } }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error) { return error instanceof Error ? error.message.slice(0, 400) : "COLLECTOR_FAILED"; }
