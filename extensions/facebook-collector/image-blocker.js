"use strict";

// Network policy for extension-owned tabs only. The page/session is never
// touched: SOURCE_SCAN gets per-tab session rules, while GALLERY_HYDRATION
// deliberately has no blocking rule and can fetch exact-bound media.
(function installCollectorImagePolicy(scope) {
  const SOURCE_SCAN_DATA_ONLY = "SOURCE_SCAN_DATA_ONLY";
  const GALLERY_HYDRATION_MEDIA_ALLOWED = "GALLERY_HYDRATION_MEDIA_ALLOWED";
  const RULE_ID_BASE = 1_700_000_000;
  const RULE_ID_MAX = RULE_ID_BASE + 2_000_000;
  const CDN_MEDIA_REGEX = "^https?://[^/]*(?:fbcdn\\.net|facebook\\.com)/.*(?:\\.(?:jpe?g|png|gif|webp|avif)(?:[?#].*)?$|/p[0-9]+x[0-9]+(?:[/?#]|$))";
  const tabs = new Map();
  const sessions = new Map();

  function emptyTelemetry(mode) {
    return {
      imageMode: mode,
      imageRequestsBlocked: 0,
      imageRequestsAllowed: 0,
      imageResponsesReceived: 0,
      imageBytesReceived: 0,
      listingImageRequestsStarted: 0,
      listingImageResponsesReceived: 0,
      listingImageBytesReceived: 0,
      thumbnailsDownloaded: 0,
      fullImagesDownloaded: 0,
      fullGalleriesDownloaded: 0,
      photoViewerNavigations: 0,
      photoViewerNavigationsWithImageBytes: 0,
    };
  }

  function ruleIds(tabId) {
    const normalized = Number(tabId);
    if (!Number.isInteger(normalized) || normalized < 0 || normalized > 900_000) return [];
    return [RULE_ID_BASE + normalized * 2, RULE_ID_BASE + normalized * 2 + 1];
  }

  function isImageLike(details) {
    const type = String(details?.type || "").toLowerCase();
    if (type === "image") return true;
    if (!["media", "xmlhttprequest", "fetch"].includes(type)) return false;
    try {
      const url = new URL(String(details?.url || ""));
      return /(?:^|\.)fbcdn\.net$/i.test(url.hostname) || /(?:^|\.)facebook\.com$/i.test(url.hostname) && /(?:jpe?g|png|gif|webp|avif|\/p\d+x\d+)/i.test(`${url.pathname}${url.search}`);
    } catch {
      return false;
    }
  }

  function contentLength(headers) {
    for (const header of Array.isArray(headers) ? headers : []) {
      if (String(header?.name || "").toLowerCase() !== "content-length") continue;
      const value = Number(header.value);
      if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    }
    return 0;
  }

  function sessionForTab(tabId) { return tabs.get(Number(tabId)) || null; }
  function bump(session, key, amount = 1) { session.telemetry[key] = Math.max(0, Number(session.telemetry[key] || 0) + amount); }

  function beforeRequest(details) {
    const session = sessionForTab(details?.tabId);
    if (!session || !isImageLike(details)) return;
    if (session.mode === SOURCE_SCAN_DATA_ONLY) {
      bump(session, "imageRequestsBlocked");
      return;
    }
    bump(session, "imageRequestsAllowed");
    bump(session, "listingImageRequestsStarted");
  }

  function completedRequest(details) {
    const session = sessionForTab(details?.tabId);
    if (!session || !isImageLike(details)) return;
    const bytes = contentLength(details?.responseHeaders);
    bump(session, "imageResponsesReceived");
    bump(session, "imageBytesReceived", bytes);
    if (session.mode !== GALLERY_HYDRATION_MEDIA_ALLOWED) {
      if (session.photoViewer) bump(session, "photoViewerNavigationsWithImageBytes");
      return;
    }
    bump(session, "listingImageResponsesReceived");
    bump(session, "listingImageBytesReceived", bytes);
    if (String(details?.type || "").toLowerCase() === "image") {
      bump(session, "thumbnailsDownloaded");
      bump(session, "fullImagesDownloaded");
      if (session.telemetry.fullGalleriesDownloaded === 0) bump(session, "fullGalleriesDownloaded");
    }
  }

  if (scope.chrome?.webRequest?.onBeforeRequest?.addListener) {
    scope.chrome.webRequest.onBeforeRequest.addListener(beforeRequest, { urls: ["<all_urls>"] });
  }
  if (scope.chrome?.webRequest?.onCompleted?.addListener) {
    scope.chrome.webRequest.onCompleted.addListener(completedRequest, { urls: ["<all_urls>"] }, ["responseHeaders"]);
  }

  async function clearRules(tabId) {
    const ids = ruleIds(tabId);
    if (!ids.length || !scope.chrome?.declarativeNetRequest?.updateSessionRules) return;
    await scope.chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {});
  }

  async function attachTab(tabId, { sessionId, mode = SOURCE_SCAN_DATA_ONLY, photoViewer = false } = {}) {
    const normalizedTabId = Number(tabId);
    if (!Number.isInteger(normalizedTabId) || normalizedTabId < 0) throw new Error("SOURCE_SCAN_TAB_ID_INVALID");
    if (mode !== SOURCE_SCAN_DATA_ONLY && mode !== GALLERY_HYDRATION_MEDIA_ALLOWED) throw new Error("COLLECTOR_IMAGE_MODE_INVALID");
    const session = sessions.get(String(sessionId)) || { mode, tabIds: new Set(), telemetry: emptyTelemetry(mode) };
    session.mode = mode;
    session.tabIds.add(normalizedTabId);
    if (photoViewer) bump(session, "photoViewerNavigations");
    sessions.set(String(sessionId), session);
    await clearRules(normalizedTabId);
    if (mode === SOURCE_SCAN_DATA_ONLY) {
      if (!scope.chrome?.declarativeNetRequest?.updateSessionRules) throw new Error("SOURCE_SCAN_IMAGE_BLOCKER_UNAVAILABLE");
      const ids = ruleIds(normalizedTabId);
      await scope.chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: ids,
        addRules: [
          { id: ids[0], priority: 1000, action: { type: "block" }, condition: { urlFilter: "|http", resourceTypes: ["image"], tabIds: [normalizedTabId] } },
          { id: ids[1], priority: 1000, action: { type: "block" }, condition: { regexFilter: CDN_MEDIA_REGEX, resourceTypes: ["media", "xmlhttprequest", "fetch"], tabIds: [normalizedTabId] } },
        ],
      });
    }
    tabs.set(normalizedTabId, { mode, sessionId: String(sessionId), telemetry: session.telemetry, photoViewer });
    return { tabId: normalizedTabId, mode, ruleIds: ruleIds(normalizedTabId) };
  }

  async function detachTab(tabId) {
    const normalizedTabId = Number(tabId);
    const attached = tabs.get(normalizedTabId);
    tabs.delete(normalizedTabId);
    await clearRules(normalizedTabId);
    if (attached) {
      const session = sessions.get(attached.sessionId);
      session?.tabIds.delete(normalizedTabId);
    }
  }

  function startSession(sessionId, mode = SOURCE_SCAN_DATA_ONLY) {
    const id = String(sessionId);
    const current = sessions.get(id);
    if (current) return current;
    const session = { mode, tabIds: new Set(), telemetry: emptyTelemetry(mode) };
    sessions.set(id, session);
    return session;
  }

  function markPhotoViewerNavigation(tabId, withImageBytes = false) {
    const attached = tabs.get(Number(tabId));
    if (!attached) return;
    const session = sessions.get(attached.sessionId);
    if (!session) return;
    bump(session, "photoViewerNavigations");
    if (withImageBytes) bump(session, "photoViewerNavigationsWithImageBytes");
  }

  function snapshot(sessionId) {
    const session = sessions.get(String(sessionId));
    return { ...(session?.telemetry || emptyTelemetry(SOURCE_SCAN_DATA_ONLY)) };
  }

  async function finishSession(sessionId) {
    const id = String(sessionId);
    const session = sessions.get(id);
    const result = snapshot(id);
    for (const tabId of [...(session?.tabIds || [])]) await detachTab(tabId);
    sessions.delete(id);
    return result;
  }

  async function cleanupStaleRules() {
    const api = scope.chrome?.declarativeNetRequest;
    if (!api?.getSessionRules || !api.updateSessionRules) return;
    const rules = await api.getSessionRules().catch(() => []);
    const removeRuleIds = (Array.isArray(rules) ? rules : []).map((rule) => Number(rule.id)).filter((id) => id >= RULE_ID_BASE && id <= RULE_ID_MAX);
    if (removeRuleIds.length) await api.updateSessionRules({ removeRuleIds }).catch(() => {});
  }

  scope.FlipCollectorImagePolicy = {
    SOURCE_SCAN_DATA_ONLY,
    GALLERY_HYDRATION_MEDIA_ALLOWED,
    attachTab,
    detachTab,
    startSession,
    snapshot,
    finishSession,
    markPhotoViewerNavigation,
    cleanupStaleRules,
  };
})(globalThis);
