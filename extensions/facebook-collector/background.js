"use strict";

const DEFAULT_SOURCES = [
  "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/",
  "https://www.facebook.com/groups/402796264871862/",
  "https://www.facebook.com/groups/2928219830782023/",
  "https://www.facebook.com/groups/1253809205540869/",
  "https://www.facebook.com/groups/1424921570856189/",
  "https://www.facebook.com/groups/1689328011096404/"
];
const SEARCH_QUERIES = ["sprzedam", "na sprzedaż", "mieszkanie", "2 pokoje", "3 pokoje"];

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
  if (!tab?.id || !isFacebookSource(tab.url)) throw new Error("OPEN_FACEBOOK_GROUP_OR_PROFILE");
  const scanId = crypto.randomUUID();
  return collectTabSource(tab.id, tab.url, scanId);
}

async function collectConfiguredSources() {
  const config = await configValue();
  const sources = Array.isArray(config.sources) && config.sources.length ? config.sources : DEFAULT_SOURCES;
  const scanId = crypto.randomUUID();
  const results = [];
  for (const sourceUrl of sources.slice(0, 20)) {
    let tab;
    try {
      tab = await chrome.tabs.create({ url: sourceUrl, active: false });
      await waitForTab(tab.id, 30_000);
      results.push(await collectTabSource(tab.id, sourceUrl, scanId));
    } catch (error) {
      results.push({ sourceUrl, status: "FAILED", error: safeError(error) });
    } finally {
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
  const result = { scanId, sources: results, finishedAt: new Date().toISOString() };
  await chrome.storage.local.set({ collectorLastResult: result, collectorState: { status: "idle", finishedAt: result.finishedAt } });
  return result;
}

async function collectTabSource(tabId, sourceUrl, scanId) {
  await chrome.storage.local.set({ collectorState: { status: "collecting", sourceUrl, startedAt: new Date().toISOString() } });
  const primary = await collectFromTab(tabId, { minScrolls: 3, maxScrolls: 18, maxPosts: 50, budgetMs: 110_000 });
  let posts = primary.posts;
  const searchRuns = [];
  if (primary.health.status === "DEGRADED" && primary.source.sourceType === "GROUP") {
    const searchStart = Date.now();
    for (const query of SEARCH_QUERIES) {
      if (Date.now() - searchStart >= 60_000 || posts.length >= 50) break;
      const searchUrl = `https://www.facebook.com/groups/${primary.source.sourceId}/search/?q=${encodeURIComponent(query)}`;
      await chrome.tabs.update(tabId, { url: searchUrl });
      await waitForTab(tabId, 20_000);
      const search = await collectFromTab(tabId, { minScrolls: 2, maxScrolls: 2, maxPosts: 50, budgetMs: Math.min(12_000, 60_000 - (Date.now() - searchStart)), searchMode: true });
      searchRuns.push({ query, ...search });
      posts = mergePosts([...posts, ...search.posts]).slice(0, 50);
    }
    await chrome.tabs.update(tabId, { url: primary.source.sourceUrl });
  }
  const health = healthAfterSearch(primary.health, posts.length, searchRuns);
  const batch = { scanId, batchId: crypto.randomUUID(), sourceId: primary.source.sourceId, sourceType: primary.source.sourceType, sourceUrl: primary.source.sourceUrl, collectedAt: new Date().toISOString(), health, posts };
  const upload = await uploadBatch(batch);
  const result = { sourceUrl: primary.source.sourceUrl, sourceId: primary.source.sourceId, health, captured: posts.length, searchFallbackUsed: searchRuns.length > 0, upload, iterations: primary.iterations };
  await chrome.storage.local.set({ collectorLastResult: result, collectorState: { status: "idle", finishedAt: new Date().toISOString() } });
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

function healthAfterSearch(primary, captured, searchRuns) {
  if (!searchRuns.length) return primary;
  const improved = captured > primary.capturedPostCount;
  const reasons = improved ? primary.reasons.filter((reason) => !["COLLECTOR_LOW_CAPTURE_COUNT", "COLLECTOR_LOW_CAPTURE_RATIO", "COLLECTOR_GROWING_FEED_WITHOUT_NEW_IDS"].includes(reason)) : primary.reasons;
  return { ...primary, status: reasons.length ? "DEGRADED" : "HEALTHY", capturedPostCount: captured, captureRatio: primary.visibleCardCount ? Math.min(1, captured / primary.visibleCardCount) : captured ? 1 : 0, durationMs: primary.durationMs + searchRuns.reduce((sum, run) => sum + run.health.durationMs, 0), stopReason: improved ? "SEARCH_FALLBACK_COMPLETED" : primary.stopReason, reasons };
}

function mergePosts(posts) {
  const map = new Map();
  for (const post of posts) {
    const current = map.get(post.postId);
    map.set(post.postId, current ? { ...current, author: current.author || post.author, text: longer(current.text, post.text), publishedAt: current.publishedAt || post.publishedAt, timestampText: current.timestampText || post.timestampText, discoveryLayers: [...new Set([...(current.discoveryLayers || []), ...(post.discoveryLayers || [])])], firstSeenIteration: Math.min(current.firstSeenIteration, post.firstSeenIteration), media: mergeMedia([...(current.media || []), ...(post.media || [])]) } : post);
  }
  return [...map.values()];
}
function mergeMedia(media) { return [...new Map(media.map((item) => [item.mediaId || item.url, item])).values()]; }
function longer(a, b) { return !a ? b : !b ? a : b.length > a.length ? b : a; }
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
function isFacebookSource(value) { try { const url = new URL(value); return url.hostname === "www.facebook.com" && !/\/login|\/checkpoint/i.test(url.pathname); } catch { return false; } }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeError(error) { return error instanceof Error ? error.message.slice(0, 400) : "COLLECTOR_FAILED"; }
