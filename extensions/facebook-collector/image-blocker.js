"use strict";

// Network policy for extension-owned tabs only. The page/session is never
// touched: SOURCE_SCAN gets per-tab session rules, while GALLERY_HYDRATION
// deliberately has no blocking rule and can fetch exact-bound media.
(function installCollectorImagePolicy(scope) {
  const SOURCE_SCAN_DATA_ONLY = "SOURCE_SCAN_DATA_ONLY";
  const GALLERY_HYDRATION_MEDIA_ALLOWED = "GALLERY_HYDRATION_MEDIA_ALLOWED";
  const DNR_POLICY_VERSION = "SOURCE_SCAN_IMAGE_ONLY_V2";
  const RULE_ID_BASE = 1_700_000_000;
  const RULE_ID_MAX = RULE_ID_BASE + 2_000_000;
  const CDN_IMAGE_REGEX = "^https?://[^/]*(?:fbcdn\\.net|facebook\\.com)/.*(?:\\.(?:jpe?g|png|gif|webp|avif)(?:[?#].*)?$|/p[0-9]+x[0-9]+(?:[/?#]|$))";
  let nextRuleId = RULE_ID_BASE;
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
      imageRequestTypeCounts: {},
      imageResponseTypeCounts: {},
      imageResponseSamples: [],
    };
  }

  function legacyRuleIds(tabId) {
    const normalized = Number(tabId);
    if (!Number.isInteger(normalized) || normalized < 0) return [];
    const first = RULE_ID_BASE + normalized * 2;
    if (!Number.isSafeInteger(first) || first > RULE_ID_MAX) return [];
    return [first, first + 1].filter((id) => id <= RULE_ID_MAX);
  }

  function isImageLike(details) {
    const type = String(details?.type || "").toLowerCase();
    if (type === "image") return true;
    if (!["media", "xmlhttprequest", "fetch"].includes(type)) return false;
    try {
      const url = new URL(String(details?.url || ""));
      return /(?:^|\.)fbcdn\.net$/i.test(url.hostname) && /(?:jpe?g|png|gif|webp|avif|\/p\d+x\d+)/i.test(`${url.pathname}${url.search}`)
        || /(?:^|\.)facebook\.com$/i.test(url.hostname) && /(?:jpe?g|png|gif|webp|avif|\/p\d+x\d+)/i.test(`${url.pathname}${url.search}`);
    } catch {
      return false;
    }
  }

  function requestType(details) { return String(details?.type || "unknown").toLowerCase().slice(0, 40); }
  function requestSample(details, bytes = 0) {
    try {
      const url = new URL(String(details?.url || ""));
      return { type: requestType(details), host: url.hostname.slice(0, 120), path: url.pathname.slice(0, 300), tabId: Number(details?.tabId), bytes };
    } catch {
      return { type: requestType(details), host: null, path: null, tabId: Number(details?.tabId), bytes };
    }
  }
  function bumpType(session, key, details) {
    const type = requestType(details);
    const counts = session.telemetry[key];
    counts[type] = Math.max(0, Number(counts[type] || 0) + 1);
  }
  function addResponseSample(session, details, bytes) {
    if (!Array.isArray(session.telemetry.imageResponseSamples) || session.telemetry.imageResponseSamples.length >= 20) return;
    session.telemetry.imageResponseSamples.push(requestSample(details, bytes));
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
    bumpType(session, "imageRequestTypeCounts", details);
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
    bumpType(session, "imageResponseTypeCounts", details);
    addResponseSample(session, details, bytes);
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

  async function clearRules(tabId, explicitRuleIds = []) {
    const attachedRuleIds = tabs.get(Number(tabId))?.ruleIds || [];
    const ids = [...new Set([...explicitRuleIds, ...attachedRuleIds, ...legacyRuleIds(tabId)].filter((id) => Number.isInteger(id) && id >= RULE_ID_BASE && id <= RULE_ID_MAX))];
    if (!ids.length || !scope.chrome?.declarativeNetRequest?.updateSessionRules) return;
    await invokeChrome(scope.chrome.declarativeNetRequest.updateSessionRules.bind(scope.chrome.declarativeNetRequest), [{ removeRuleIds: ids }]).catch(() => {});
  }

  function sanitizeRule(rule) {
    if (!rule || typeof rule !== "object") return null;
    const condition = rule.condition && typeof rule.condition === "object" ? rule.condition : {};
    const safe = {
      id: Number.isInteger(rule.id) ? rule.id : null,
      priority: Number.isInteger(rule.priority) ? rule.priority : null,
      action: { type: typeof rule.action?.type === "string" ? rule.action.type : null },
      condition: {
        tabIds: Array.isArray(condition.tabIds) ? condition.tabIds.filter((id) => Number.isInteger(id)) : [],
        resourceTypes: Array.isArray(condition.resourceTypes) ? condition.resourceTypes.filter((type) => typeof type === "string") : [],
      },
    };
    for (const key of ["urlFilter", "regexFilter", "requestDomains", "initiatorDomains"]) {
      const value = condition[key];
      if (typeof value === "string") safe.condition[key] = value.slice(0, 500);
      else if (Array.isArray(value)) safe.condition[key] = value.filter((item) => typeof item === "string").map((item) => item.slice(0, 120)).slice(0, 20);
    }
    return safe;
  }

  function sanitizeRuleUpdate(options) {
    if (!options || typeof options !== "object") return null;
    return {
      removeRuleIds: Array.isArray(options.removeRuleIds) ? options.removeRuleIds.filter((id) => Number.isInteger(id)) : [],
      addRules: Array.isArray(options.addRules) ? options.addRules.map(sanitizeRule).filter(Boolean).slice(0, 10) : [],
    };
  }

  function runtimeDiagnostics() {
    let manifest = null;
    try { manifest = scope.chrome?.runtime?.getManifest?.() || null; } catch { /* diagnostic only */ }
    const permissions = Array.isArray(manifest?.permissions) ? manifest.permissions.filter((item) => typeof item === "string") : [];
    return {
      policyVersion: DNR_POLICY_VERSION,
      dnrAvailable: Boolean(scope.chrome?.declarativeNetRequest),
      updateSessionRulesAvailable: typeof scope.chrome?.declarativeNetRequest?.updateSessionRules === "function",
      getSessionRulesAvailable: typeof scope.chrome?.declarativeNetRequest?.getSessionRules === "function",
      manifestVersion: typeof manifest?.version === "string" ? manifest.version.slice(0, 40) : null,
      dnrPermissionPresent: permissions.includes("declarativeNetRequest"),
    };
  }

  function invokeChrome(method, args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const callback = (value) => {
        const runtimeMessage = scope.chrome?.runtime?.lastError?.message;
        if (runtimeMessage) {
          const error = new Error(String(runtimeMessage));
          error.name = "ChromeRuntimeError";
          error.chromeRuntimeLastErrorMessage = String(runtimeMessage);
          finish(reject, error);
          return;
        }
        finish(resolve, value);
      };
      let returned;
      try {
        returned = method(...args, callback);
      } catch (error) {
        finish(reject, error);
        return;
      }
      if (returned && typeof returned.then === "function") returned.then((value) => finish(resolve, value), (error) => finish(reject, error));
    });
  }

  async function sessionRuleState() {
    const api = scope.chrome?.declarativeNetRequest;
    if (typeof api?.getSessionRules !== "function") return { rules: [], error: "DNR_GET_SESSION_RULES_UNAVAILABLE" };
    try {
      const rules = await invokeChrome(api.getSessionRules.bind(api), []);
      return { rules: (Array.isArray(rules) ? rules : []).map(sanitizeRule).filter(Boolean).slice(0, 100), error: null };
    } catch (error) {
      return { rules: [], error: typeof error?.message === "string" ? error.message.slice(0, 400) : "DNR_GET_SESSION_RULES_FAILED" };
    }
  }

  async function allocateRuleId() {
    const state = await sessionRuleState();
    const used = new Set([
      ...state.rules.map((rule) => rule.id).filter((id) => Number.isInteger(id)),
      ...[...tabs.values()].flatMap((tab) => Array.isArray(tab.ruleIds) ? tab.ruleIds : []).filter((id) => Number.isInteger(id)),
    ]);
    const capacity = RULE_ID_MAX - RULE_ID_BASE + 1;
    if (used.size >= capacity) throw new Error("SOURCE_SCAN_IMAGE_RULE_ID_EXHAUSTED");
    for (let attempt = 0; attempt <= used.size; attempt += 1) {
      const candidate = nextRuleId;
      nextRuleId = candidate >= RULE_ID_MAX ? RULE_ID_BASE : candidate + 1;
      if (!used.has(candidate)) return candidate;
    }
    throw new Error("SOURCE_SCAN_IMAGE_RULE_ID_EXHAUSTED");
  }

  async function persistRuleDiagnostics(diagnostics) {
    await Promise.resolve(scope.chrome?.storage?.local?.set?.({ collectorDnrDiagnostics: diagnostics })).catch(() => {});
  }

  async function installRules(tabId, options) {
    const sanitizedOptions = sanitizeRuleUpdate(options);
    const targetRuleIds = sanitizedOptions?.addRules?.map((rule) => rule.id).filter((id) => Number.isInteger(id)) || [];
    const before = await sessionRuleState();
    const firstRule = Array.isArray(options?.addRules) ? options.addRules[0] : null;
    const baseDiagnostics = {
      tabId,
      ruleIds: targetRuleIds,
      chromeErrorName: null,
      chromeErrorMessage: null,
      chromeRuntimeLastErrorMessage: null,
      options: sanitizedOptions,
      runtime: runtimeDiagnostics(),
      runtimeValues: {
        tabIdType: typeof tabId,
        tabIdIsInteger: Number.isInteger(tabId),
        ruleId: firstRule?.id ?? null,
        ruleIdType: typeof firstRule?.id,
        priority: firstRule?.priority ?? null,
        priorityType: typeof firstRule?.priority,
      },
      sessionRulesBefore: before.rules,
      sessionRulesBeforeError: before.error,
      targetRulePresentBefore: before.rules.some((rule) => targetRuleIds.includes(rule.id)),
      duplicateAddRuleIds: targetRuleIds.length !== new Set(targetRuleIds).size,
    };
    try {
      await invokeChrome(scope.chrome.declarativeNetRequest.updateSessionRules.bind(scope.chrome.declarativeNetRequest), [options]);
      const after = await sessionRuleState();
      const diagnostics = {
        ...baseDiagnostics,
        installResult: "PASS",
        sessionRulesAfter: after.rules,
        sessionRulesAfterError: after.error,
        targetRulePresentAfter: after.rules.some((rule) => targetRuleIds.includes(rule.id)),
      };
      await persistRuleDiagnostics(diagnostics);
      if (!after.error && targetRuleIds.length > 0 && !diagnostics.targetRulePresentAfter) throw Object.assign(new Error("DNR_TARGET_RULE_NOT_PRESENT_AFTER_INSTALL"), { diagnostics });
      return diagnostics;
    } catch (error) {
      const after = await sessionRuleState();
      const wrapped = new Error("SOURCE_SCAN_IMAGE_RULE_INSTALL_FAILED");
      wrapped.code = "SOURCE_SCAN_IMAGE_RULE_INSTALL_FAILED";
      wrapped.cause = error;
      wrapped.diagnostics = {
        ...baseDiagnostics,
        chromeErrorName: typeof error?.name === "string" ? error.name.slice(0, 120) : "Error",
        chromeErrorMessage: typeof error?.message === "string" ? error.message.slice(0, 1000) : "DNR_UPDATE_FAILED",
        chromeRuntimeLastErrorMessage: typeof error?.chromeRuntimeLastErrorMessage === "string" ? error.chromeRuntimeLastErrorMessage.slice(0, 1000) : null,
        installResult: "FAIL",
        sessionRulesAfter: after.rules,
        sessionRulesAfterError: after.error,
        targetRulePresentAfter: after.rules.some((rule) => targetRuleIds.includes(rule.id)),
      };
      await persistRuleDiagnostics(wrapped.diagnostics);
      throw wrapped;
    }
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
      const ids = [await allocateRuleId(), await allocateRuleId()];
      const installDiagnostics = await installRules(normalizedTabId, {
        removeRuleIds: ids,
        addRules: [
          { id: ids[0], priority: 1, action: { type: "block" }, condition: { resourceTypes: ["image"], tabIds: [normalizedTabId] } },
          { id: ids[1], priority: 1, action: { type: "block" }, condition: { regexFilter: CDN_IMAGE_REGEX, resourceTypes: ["media", "xmlhttprequest"], tabIds: [normalizedTabId] } },
        ],
      });
      tabs.set(normalizedTabId, { mode, sessionId: String(sessionId), telemetry: session.telemetry, photoViewer, ruleIds: ids });
      return { tabId: normalizedTabId, mode, ruleIds: ids, installDiagnostics };
    }
    tabs.set(normalizedTabId, { mode, sessionId: String(sessionId), telemetry: session.telemetry, photoViewer });
    return { tabId: normalizedTabId, mode, ruleIds: [] };
  }

  async function detachTab(tabId) {
    const normalizedTabId = Number(tabId);
    const attached = tabs.get(normalizedTabId);
    tabs.delete(normalizedTabId);
    await clearRules(normalizedTabId, attached?.ruleIds || []);
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
    DNR_POLICY_VERSION,
    attachTab,
    detachTab,
    startSession,
    snapshot,
    finishSession,
    markPhotoViewerNavigation,
    cleanupStaleRules,
    sanitizeRuleUpdate,
  };
})(globalThis);
