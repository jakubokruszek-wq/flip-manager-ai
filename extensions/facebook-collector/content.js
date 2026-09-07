(function installPageCollector() {
  "use strict";
  const core = globalThis.FlipFacebookCollectorCore;
  if (!core || globalThis.__flipCollectorContent) return;
  globalThis.__flipCollectorContent = true;
  const SOURCE_SCAN_DATA_ONLY = "SOURCE_SCAN_DATA_ONLY";
  const GALLERY_HYDRATION_MEDIA_ALLOWED = "GALLERY_HYDRATION_MEDIA_ALLOWED";
  const networkRecords = new Map();
  let networkResponses = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "FLIP_COLLECTOR_NETWORK") return;
    networkResponses += 1;
    for (const record of event.data.payload?.records || []) networkRecords.set(record.postId, record);
    while (networkRecords.size > 200) networkRecords.delete(networkRecords.keys().next().value);
  });

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type === "COLLECTOR_PING") { respond({ ready: true }); return false; }
    if (message?.type === "COLLECTOR_SELF_TEST") { respond({ ok: true, requestId: typeof message.requestId === "string" ? message.requestId.slice(0, 80) : null, href: location.href, documentReadyState: document.readyState, collectorVersion: "0.1.0" }); return false; }
    if (message?.type === "HYDRATE_FACEBOOK_GALLERY") {
      void hydrateFacebookGallery(message.options || {}).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
      return true;
    }
    if (message?.type === "RESOLVE_SEARCH_MEDIA_TILE") {
      void resolveSearchMediaTile(message.options || {}).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
      return true;
    }
    if (message?.type !== "COLLECT_SOURCE") return false;
    void collectSource(message.options || {}).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  });

  async function hydrateFacebookGallery(options) {
    if (options.imageMode !== GALLERY_HYDRATION_MEDIA_ALLOWED) return Promise.resolve({ status: "FAILED", error: "FACEBOOK_GALLERY_IMAGE_MODE_INVALID", candidates: [], sourceMediaCount: 0 });
    const expectedPostId = String(options.expectedPostId || "");
    const expectedUrl = String(options.expectedUrl || "");
    const resolvedUrl = String(options.resolvedUrl || "");
    if (!/^\d{5,30}$/.test(expectedPostId)) return Promise.resolve({ status: "FAILED", error: "FACEBOOK_GALLERY_POST_ID_INVALID", expectedPostId: null, candidates: [], sourceMediaCount: 0 });
    let expectedGroup = null;
    try { expectedGroup = new URL(expectedUrl).pathname.match(/^\/groups\/([^/]+)(?:\/|$)/i)?.[1] || null; } catch { /* invalid source is rejected below */ }
    if (!expectedGroup) return Promise.resolve({ status: "FAILED", error: "FACEBOOK_GALLERY_SOURCE_URL_INVALID", expectedPostId, candidates: [], sourceMediaCount: 0 });
    let resolvedGroup = null;
    try { resolvedGroup = new URL(resolvedUrl).pathname.match(new RegExp(`^/groups/([^/]+)/(?:permalink|posts)/${expectedPostId}(?:/|$)`, "i"))?.[1] || null; } catch { /* invalid resolved URL is rejected below */ }
    if (!resolvedGroup) return { status: "FAILED", error: "FACEBOOK_GALLERY_RESOLVED_URL_INVALID", expectedPostId, candidates: [], sourceMediaCount: 0 };
    const exactPath = new RegExp(`^/groups/${escapeRegExp(resolvedGroup)}/(?:permalink|posts)/${expectedPostId}(?:/|$)`, "i");
    let exactPageContext = false;
    try {
      const resolved = new URL(resolvedUrl);
      const current = new URL(location.href);
      exactPageContext = /(^|\.)facebook\.com$/i.test(resolved.hostname) && /(^|\.)facebook\.com$/i.test(current.hostname) && exactPath.test(resolved.pathname) && exactPath.test(current.pathname);
    } catch { /* invalid runtime location remains fail-closed */ }
    if (!exactPageContext) return { status: "FAILED", error: "FACEBOOK_GALLERY_PAGE_CONTEXT_MISMATCH", expectedPostId, candidates: [], sourceMediaCount: 0 };
    const groupBindingSource = resolvedGroup === expectedGroup ? "EXACT_SOURCE_GROUP" : "DIRECT_NAVIGATION_REDIRECT";
    const rootDeadline = Date.now() + 8_000;
    let root = null;
    let rootBindingSource = null;
    let author = null;
    let rootText = null;
    let structuredRoot = null;
    let lastRootCount = 0;
    do {
      const structuredEvidence = galleryStructuredRootEvidence(networkRecords.get(expectedPostId), expectedPostId, resolvedGroup, exactPath);
      if (structuredEvidence) {
        structuredRoot = structuredEvidence;
        rootBindingSource = "EXACT_STRUCTURED_STORY";
        author = structuredEvidence.author;
        rootText = structuredEvidence.rootText;
        break;
      }
      const permalinkLinks = [...document.querySelectorAll("a[href]")].filter((anchor) => {
        if (isCommentDescendant(anchor)) return false;
        try { const url = new URL(anchor.href); return /(^|\.)facebook\.com$/i.test(url.hostname) && exactPath.test(url.pathname); } catch { return false; }
      });
      const selfLinkRoots = [...new Set(permalinkLinks.map((anchor) => anchor.closest('[role="article"]') || anchor.closest("[data-pagelet]")))] .filter(Boolean);
      let roots = selfLinkRoots.map(galleryRootEvidence).filter((evidence) => evidence.author && evidence.rootText).map((evidence) => evidence.root);
      rootBindingSource = selfLinkRoots.length > 0 ? "EXACT_SELF_LINK" : null;
      if (selfLinkRoots.length === 0) {
        roots = [...document.querySelectorAll('[role="article"]')]
          .filter((article) => !article.parentElement?.closest('[role="article"]') && !isCommentDescendant(article))
          .map(galleryRootEvidence)
          .filter((evidence) => evidence.author && evidence.rootText)
          .map((evidence) => evidence.root);
        rootBindingSource = roots.length > 0 ? "EXACT_PAGE_SINGLE_ROOT" : null;
      }
      lastRootCount = roots.length;
      if (roots.length > 1) return { status: "FAILED", error: "FACEBOOK_GALLERY_ROOT_AMBIGUOUS", expectedPostId, candidates: [], sourceMediaCount: 0, rootBindingSource, rootCount: roots.length };
      root = roots[0] || null;
      if (root) {
        const evidence = galleryRootEvidence(root);
        author = evidence.author;
        rootText = evidence.rootText;
        if (author && rootText) break;
      }
      if (Date.now() < rootDeadline) await wait(Math.min(250, rootDeadline - Date.now()));
    } while (Date.now() < rootDeadline);
    if (!root && !structuredRoot) return { status: "FAILED", error: "FACEBOOK_GALLERY_ROOT_NOT_FOUND", expectedPostId, candidates: [], sourceMediaCount: 0, rootBindingSource, rootCount: lastRootCount };
    if (!author || !rootText) return { status: "FAILED", error: !author ? "FACEBOOK_GALLERY_ROOT_AUTHOR_MISSING" : "FACEBOOK_GALLERY_ROOT_TEXT_MISSING", expectedPostId, candidates: [], sourceMediaCount: 0, rootBindingSource, rootCount: lastRootCount };
    const candidates = [];
    const seen = new Set();
    for (const media of structuredRoot?.media || []) {
      const key = media.mediaId || media.url;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ url: media.url.slice(0, 2_000), mediaId: media.mediaId, expectedPostId, storyRootPostId: expectedPostId, boundPostId: expectedPostId, bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY", rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE", classificationConfidence: 0.95, structuredPostMediaProvenance: true });
    }
    if (root) {
      const rootIsArticle = root.matches?.('[role="article"]') === true;
      const sameRoot = (node) => !rootIsArticle || node.closest('[role="article"]') === root;
      for (const anchor of root.querySelectorAll('a[href*="/photo/"], a[href*="/photo.php"]')) {
        if (!sameRoot(anchor) || isCommentDescendant(anchor)) continue;
        let url;
        try { url = new URL(anchor.href); } catch { continue; }
        const mediaId = url.searchParams.get("fbid") || mediaIdFromUrl(url.toString());
        const image = anchor.querySelector("img") || anchor.closest("div")?.querySelector("img");
        const mediaUrl = image?.currentSrc || image?.src || null;
        const key = mediaId || mediaUrl;
        if (!mediaUrl || !/^https:\/\//i.test(mediaUrl) || !/^\d{5,30}$/.test(String(mediaId || "")) || seen.has(key)) continue;
        seen.add(key);
        candidates.push({ url: mediaUrl.slice(0, 2_000), mediaId, expectedPostId, storyRootPostId: expectedPostId, boundPostId: expectedPostId, bindingConfidence: 1, bindingProvenance: "EXACT_ROOT_STORY", rootStoryUnique: true, foreignPostIdsDetected: [], classification: "PROPERTY_IMAGE", classificationConfidence: 0.95, structuredPostMediaProvenance: false });
      }
    }
    if (candidates.length === 0) return { status: "FAILED", error: "FACEBOOK_GALLERY_EXACT_MEDIA_NOT_FOUND", expectedPostId, candidates: [], sourceMediaCount: 0, authorFound: true, rootTextFound: true, rootBindingSource, groupBindingSource, rootCount: 1 };
    return { status: "COMPLETE", expectedPostId, sourceMediaCount: candidates.length, candidates, authorFound: true, rootTextFound: true, rootBindingSource, groupBindingSource, rootCount: 1 };
  }

  function galleryRootEvidence(root) {
    const rootIsArticle = root?.matches?.('[role="article"]') === true;
    const sameRoot = (node) => !rootIsArticle || node.closest('[role="article"]') === root;
    const author = [...root.querySelectorAll("h2 a, h3 a, strong a")].filter((node) => sameRoot(node) && !isCommentDescendant(node)).map(visibleText).find(Boolean) || null;
    const rootTexts = [...root.querySelectorAll('[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"]')]
      .filter((node) => sameRoot(node) && !isCommentDescendant(node))
      .map(visibleText)
      .filter(Boolean);
    return { root, author, rootText: rootTexts.length === 1 ? rootTexts[0] : null };
  }

  function galleryStructuredRootEvidence(record, expectedPostId, resolvedGroup, exactPath) {
    if (!record || record.postId !== expectedPostId || record.sourceType !== "GROUP" || String(record.sourceId || "") !== resolvedGroup || record.identityConfidence !== "EXACT" || !visibleString(record.author) || !visibleString(record.text)) return null;
    try { const permalink = new URL(record.permalink); if (!/(^|\.)facebook\.com$/i.test(permalink.hostname) || !exactPath.test(permalink.pathname)) return null; } catch { return null; }
    const media = (Array.isArray(record.media) ? record.media : []).flatMap((item) => {
      if (!item || item.exactAssociation !== true || item.exactPostId !== expectedPostId || typeof item.url !== "string" || !/^https:\/\//i.test(item.url)) return [];
      const mediaId = /^\d{5,30}$/.test(String(item.mediaId || "")) ? String(item.mediaId) : null;
      return [{ url: item.url, mediaId }];
    });
    return { author: visibleString(record.author), rootText: visibleString(record.text), media };
  }

  async function resolveSearchMediaTile(options) {
    if (options.imageMode !== SOURCE_SCAN_DATA_ONLY) return { status: "UNVERIFIED", records: [], reasons: ["SEARCH_IMAGE_MODE_INVALID"], diagnostics: { query: String(options.searchQuery || "").slice(0, 120) || null, mediaId: String(options.mediaId || ""), photoOpened: false, structuredPayloadFound: false, currMediaId: null, containerStoryPostId: null, topLevelPostId: null, mediaAttachmentCrosscheck: false, parentPostId: null, parentPermalink: null, rootAuthorFound: false, rootTextFound: false, identityResult: "UNVERIFIED", failSubstep: "SEARCH_IMAGE_MODE_INVALID" } };
    const mediaId = String(options.mediaId || "");
    const inPage = options.inPage === true;
    const source = core.canonicalSource(options.sourceUrl);
    const current = new URL(location.href);
    const invalid = (reason) => ({ status: "UNVERIFIED", records: [], reasons: [reason], diagnostics: { query: String(options.searchQuery || "").slice(0, 120) || null, mediaId, photoOpened: false, structuredPayloadFound: false, currMediaId: null, containerStoryPostId: null, topLevelPostId: null, mediaAttachmentCrosscheck: false, parentPostId: null, parentPermalink: null, rootAuthorFound: false, rootTextFound: false, identityResult: "UNVERIFIED", failSubstep: reason } });
    if (!source || source.sourceType !== "GROUP" || !/^\d{5,30}$/.test(mediaId)) return invalid("SEARCH_MEDIA_RESOLVE_INPUT_INVALID");
    if (!inPage && (!/^\/photo(?:\.php)?(?:\/|$)/i.test(current.pathname) || current.searchParams.get("fbid") !== mediaId)) return invalid("SEARCH_MEDIA_TILE_CONTEXT_MISMATCH");
    const diagnostics = { query: String(options.searchQuery || "").slice(0, 120) || null, mediaId, photoOpened: !inPage, inPageResolution: inPage, structuredPayloadFound: false, currMediaId: null, containerStoryPostId: null, topLevelPostId: null, mediaAttachmentCrosscheck: false, parentPostId: null, parentPermalink: null, rootAuthorFound: false, rootTextFound: false, identityResult: "UNVERIFIED", failSubstep: "SEARCH_PAYLOAD_NOT_FOUND" };
    if (inPage) {
      const inPageResult = resolveSearchMediaTileFromDom(mediaId, source, options.searchQuery, diagnostics);
      if (inPageResult) return inPageResult;
    }
    const candidates = [];
    const retryMs = Math.min(4_000, Math.max(0, Number(options.resolutionWaitMs) || 4_000));
    const retryDeadline = Date.now() + retryMs;
    let verified = { status: "UNVERIFIED", records: [], reasons: ["SEARCH_MEDIA_EXACT_PARENT_NOT_PROVEN"] };
    do {
      let bytes = 0;
      for (const script of [...document.scripts].slice(0, 250)) {
        const body = script.textContent || "";
        if (!body || bytes + body.length > 4_000_000) continue;
        bytes += body.length;
        const inspected = core.inspectSearchMediaParentFromText(body, source, mediaId);
        diagnostics.structuredPayloadFound ||= inspected.structuredPayloadFound;
        diagnostics.currMediaId ||= inspected.currMediaId;
        diagnostics.containerStoryPostId ||= inspected.containerStoryPostId;
        diagnostics.topLevelPostId ||= inspected.topLevelPostId;
        diagnostics.mediaAttachmentCrosscheck ||= inspected.mediaAttachmentCrosscheck;
        diagnostics.parentPostId ||= inspected.parentPostId;
        diagnostics.parentPermalink ||= inspected.parentPermalink;
        diagnostics.rootAuthorFound ||= inspected.rootAuthorFound;
        diagnostics.rootTextFound ||= inspected.rootTextFound;
        if (inspected.identityResult === "EXACT") diagnostics.identityResult = "EXACT";
        if (inspected.failSubstep && diagnostics.failSubstep === "SEARCH_PAYLOAD_NOT_FOUND") diagnostics.failSubstep = inspected.failSubstep;
        candidates.push(...core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId, 0));
      }
      verified = core.verifySearchMediaParent(candidates, mediaId);
      if (verified.status === "VERIFIED" || Date.now() >= retryDeadline) break;
      await wait(Math.min(250, Math.max(1, retryDeadline - Date.now())));
    } while (Date.now() < retryDeadline);
    if (verified.status !== "VERIFIED") return { ...verified, diagnostics: { ...diagnostics, identityResult: "UNVERIFIED", failSubstep: diagnostics.failSubstep || verified.reasons?.[0] || "SEARCH_PARENT_UNVERIFIED" } };
    const records = verified.records.map((record) => ({ ...record, discoverySource: "SEARCH", foundInMainFeed: false, firstSeenPhase: "SEARCH", searchQuery: String(options.searchQuery || "").slice(0, 120) || null, searchQueries: options.searchQuery ? [String(options.searchQuery).slice(0, 120)] : [] }));
    return { ...verified, records, diagnostics: { ...diagnostics, identityResult: "EXACT", failSubstep: null, parentPostId: records[0]?.postId || diagnostics.parentPostId, parentPermalink: records[0]?.permalink || diagnostics.parentPermalink, rootAuthorFound: true, rootTextFound: true } };
  }

  function resolveSearchMediaTileFromDom(mediaId, source, query, diagnostics) {
    const anchors = [...document.querySelectorAll('a[href*="/photo/"][href*="fbid="], a[href*="/photo.php"][href*="fbid="]')].filter((anchor) => {
      if (isCommentDescendant(anchor)) return false;
      try { const url = new URL(anchor.href); return url.hostname === "www.facebook.com" && url.searchParams.get("fbid") === mediaId; } catch { return false; }
    });
    const records = [];
    const seenRoots = new Set();
    for (const anchor of anchors) {
      const root = anchor.closest('[role="article"]') || anchor.closest('[data-pagelet*="Feed"], [data-pagelet*="Group"]');
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      if (!root.matches?.('[role="article"]') && root.querySelectorAll('[role="article"]').length > 1) continue;
      const links = [...root.querySelectorAll('a[href]')].map((item) => {
        try { return core.parsePostLink(item.href, source); } catch { return null; }
      }).filter(Boolean);
      const uniqueLinks = [...new Map(links.map((link) => [link.postId, link])).values()];
      if (uniqueLinks.length !== 1) continue;
      const link = uniqueLinks[0];
      const scoped = (selector) => [...root.querySelectorAll(selector)].filter((node) => !isCommentDescendant(node) && (!root.matches?.('[role="article"]') || node.closest('[role="article"]') === root));
      const authorCandidates = scoped('h2 a, h3 a, strong a').map(visibleText).filter(Boolean);
      const messageCandidates = scoped('[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"]').map(visibleText).filter(Boolean);
      const author = authorCandidates.length === 1 ? authorCandidates[0] : null;
      const text = messageCandidates.length === 1 ? messageCandidates[0] : null;
      const image = anchor.querySelector("img") || anchor.closest("div")?.querySelector("img");
      const mediaUrl = image?.currentSrc || image?.src || null;
      const identity = core.resolveRootStoryIdentity({ rootPostId: link.postId, author, text, rootAuthorSource: author ? "ROOT_CARD_AUTHOR" : null, rootTextSource: text ? "ROOT_CARD_MESSAGE" : null, rootTextVerified: Boolean(author && text) }, link.postId);
      diagnostics.parentPostId ||= link.postId;
      diagnostics.parentPermalink ||= link.permalink;
      diagnostics.rootAuthorFound ||= Boolean(author);
      diagnostics.rootTextFound ||= Boolean(text);
      diagnostics.mediaAttachmentCrosscheck ||= Boolean(mediaUrl);
      if (identity.identityConfidence !== "EXACT" || !mediaUrl || !/^https:\/\/(?:[^/]+\.)?(?:fbcdn\.net|facebook\.com)\//i.test(mediaUrl)) continue;
      records.push({
        ...link,
        author: identity.author,
        text: identity.text,
        publishedAt: null,
        timestampText: null,
        media: [{ url: mediaUrl.slice(0, 2_000), mediaId, exactPostId: link.postId, exactAssociation: true, discoveryLayers: ["SEARCH_DOM"] }],
        discoveryLayers: ["SEARCH_DOM"],
        firstSeenIteration: 0,
        identityConfidence: "EXACT",
        identityReasons: ["IN_PAGE_ROOT_CARD_MEDIA_BINDING", "ROOT_TEXT_VERIFIED"],
        discoverySource: "SEARCH",
        searchQuery: String(query || "").slice(0, 120) || null,
        searchQueries: query ? [String(query).slice(0, 120)] : [],
        foundInMainFeed: false,
        firstSeenPhase: "SEARCH",
        resolvedFromMediaTile: true,
        mediaIds: [mediaId],
        parentResolutionEvidence: ["IN_PAGE_ROOT_CARD_MEDIA_BINDING"],
        rootPostId: link.postId,
        rootAuthorSource: "ROOT_CARD_AUTHOR",
        rootTextSource: "ROOT_CARD_MESSAGE",
        rootTextVerified: true,
      });
    }
    const verified = core.verifySearchMediaParent(records, mediaId);
    if (verified.status !== "VERIFIED") {
      diagnostics.failSubstep = !diagnostics.parentPostId ? "SEARCH_PARENT_POST_ID_MISSING" : !diagnostics.rootAuthorFound || !diagnostics.rootTextFound ? "SEARCH_ROOT_TEXT_MISSING" : !diagnostics.mediaAttachmentCrosscheck ? "SEARCH_MEDIA_CROSSCHECK_FAILED" : "SEARCH_PARENT_UNVERIFIED";
      return null;
    }
    diagnostics.identityResult = "EXACT";
    diagnostics.failSubstep = null;
    diagnostics.parentPostId = verified.records[0].postId;
    diagnostics.parentPermalink = verified.records[0].permalink;
    diagnostics.rootAuthorFound = true;
    diagnostics.rootTextFound = true;
    return { ...verified, diagnostics };
  }

  async function collectSource(options) {
    const imageMode = options.imageMode === GALLERY_HYDRATION_MEDIA_ALLOWED ? GALLERY_HYDRATION_MEDIA_ALLOWED : SOURCE_SCAN_DATA_ONLY;
    const source = core.canonicalSource(location.href);
    if (!source) throw new Error("FACEBOOK_SOURCE_URL_REQUIRED");
    const maxScrolls = clamp(options.maxScrolls, 0, 30, 30);
    const minScrolls = clamp(options.minScrolls, 0, maxScrolls, 3);
    const maxPosts = clamp(options.maxPosts, 1, 50, 50);
    const maxDiscoveryPosts = clamp(options.maxDiscoveryPosts, Math.max(50, maxPosts), 100, Math.max(50, maxPosts));
    const maxDiscoveryMediaTiles = clamp(options.maxDiscoveryMediaTiles ?? options.maxMediaTiles, 1, 100, 100);
    const budgetMs = clamp(options.budgetMs, 5_000, 120_000, 110_000);
    const searchMode = options.searchMode === true;
    const layerPrefix = searchMode ? "SEARCH_" : "";
    const start = performance.now();
    const iterations = [];
    let records = [];
    const mainFeedDiagnostics = new Map();
    const searchResultDiagnostics = new Map();
    const searchMediaTiles = new Map();
    const searchObservedMediaIds = new Set();
    const discoveryStartUrl = location.href;
    let rawSearchMediaTilesSeen = 0;
    let scrolls = 0;
    let consecutiveNoNew = 0;
    let consecutiveNoTileGrowth = 0;
    let consecutiveNoVisibleGrowth = 0;
    let consecutiveBottomChecks = 0;
    let consecutiveOldNewPosts = 0;
    let previousVisibleFingerprints = new Set();
    let consecutiveVisibleAdvanceWithoutCapture = 0;
    const initialHeight = document.documentElement.scrollHeight;
    let previousNetworkResponses = networkResponses;
    let stopReason = "MAX_SCROLLS";

    for (let iteration = 0; ; iteration += 1) {
      if (searchMode) {
        const tilesBeforeCollection = searchObservedMediaIds.size;
        const visibleTiles = collectSearchMediaTiles();
        rawSearchMediaTilesSeen += visibleTiles.length;
        for (const tile of visibleTiles) {
          if (searchObservedMediaIds.size < 5_000) searchObservedMediaIds.add(tile.mediaId);
          if (searchMediaTiles.has(tile.mediaId) || searchMediaTiles.size < maxDiscoveryMediaTiles) searchMediaTiles.set(tile.mediaId, tile);
        }
        consecutiveNoTileGrowth = searchObservedMediaIds.size > tilesBeforeCollection ? 0 : consecutiveNoTileGrowth + 1;
      }
      const searchCards = searchMode ? collectSearchResultCards(source, options.searchQuery, iteration) : { records: [], diagnostics: [] };
      for (const diagnostic of searchCards.diagnostics) {
        const key = `${diagnostic.postIdCandidate || "unknown"}|${diagnostic.permalinkCandidate || diagnostic.anchorHref || iteration}`;
        const previous = searchResultDiagnostics.get(key);
        searchResultDiagnostics.set(key, previous ? mergeSearchResultDiagnostic(previous, diagnostic) : diagnostic);
      }
      const dom = collectDom(source, iteration, `${layerPrefix}DOM`);
      const hydration = collectHydration(source, iteration, `${layerPrefix}HYDRATION`);
      const network = [...networkRecords.values()].map((record) => ({ ...record, firstSeenIteration: record.firstSeenIteration ?? iteration, discoveryLayers: [`${layerPrefix}NETWORK`] }));
      if (!searchMode) {
        updateMainFeedDiagnostics(mainFeedDiagnostics, dom, "DOM");
        updateMainFeedDiagnostics(mainFeedDiagnostics, hydration, "NETWORK");
        updateMainFeedDiagnostics(mainFeedDiagnostics, network, "NETWORK");
      }
      const beforeIds = new Set(records.map((record) => record.postId));
      const before = records.length;
      records = core.mergeRecords([...records, ...searchCards.records, ...dom, ...hydration, ...network], searchMode ? maxDiscoveryPosts : maxPosts);
      const added = records.length - before;
      const addedRecords = records.filter((record) => !beforeIds.has(record.postId));
      consecutiveOldNewPosts = core.updateAgeCutoffStreak(consecutiveOldNewPosts, addedRecords);
      consecutiveNoNew = added === 0 ? consecutiveNoNew + 1 : 0;
      const cards = visibleCards();
      const visibleFingerprints = new Set(cards.map(cardFingerprint).filter(Boolean));
      const newVisibleCards = [...visibleFingerprints].filter((fingerprint) => !previousVisibleFingerprints.has(fingerprint)).length;
      if (iteration > 0) consecutiveNoVisibleGrowth = newVisibleCards === 0 ? consecutiveNoVisibleGrowth + 1 : 0;
      if (iteration > 0) consecutiveVisibleAdvanceWithoutCapture = newVisibleCards > 0 && added === 0 ? consecutiveVisibleAdvanceWithoutCapture + 1 : added > 0 ? 0 : consecutiveVisibleAdvanceWithoutCapture;
      previousVisibleFingerprints = visibleFingerprints;
      const container = findScrollContainer();
      const scrollTop = container === document.scrollingElement ? window.scrollY : container.scrollTop;
      const scrollHeight = container.scrollHeight;
      const atBottomNow = isAtEndOfResults(container);
      consecutiveBottomChecks = atBottomNow ? consecutiveBottomChecks + 1 : 0;
      const pendingContentCount = searchMode ? pendingSearchContentCount() : 0;
      iterations.push({ iteration, domPostIds: ids(dom), hydrationPostIds: ids(hydration), networkPostIds: ids(network), mergedPostIds: ids(records), visibleCardCount: cards.length, newVisibleCardsThisIteration: newVisibleCards, uniqueTileCount: searchMode ? searchObservedMediaIds.size : 0, scrollTop: Math.floor(scrollTop), scrollHeight, newIdsThisIteration: added, consecutiveOldNewPosts, networkResponsesSinceLastScroll: networkResponses - previousNetworkResponses, pendingContentCount, atBottom: atBottomNow });
      previousNetworkResponses = networkResponses;
      const elapsedMs = performance.now() - start;
      const recentIterations = iterations.slice(-3);
      const networkQuietChecks = recentIterations.filter((item) => item.networkResponsesSinceLastScroll === 0).length;
      const noPendingContent = pendingContentCount === 0;
      const pageErrorFree = document.readyState === "complete" && !document.querySelector('[data-pagelet="ErrorPage"], [data-testid="page_error"]');
      const urlStable = location.href === discoveryStartUrl;
      const stableScrollPosition = recentIterations.length >= 3 && new Set(recentIterations.map((item) => item.scrollTop)).size === 1;
      const atEndOfResults = searchMode && scrolls >= minScrolls && consecutiveNoNew >= 3 && consecutiveNoTileGrowth >= 3 && consecutiveNoVisibleGrowth >= 3 && consecutiveBottomChecks >= 3 && networkQuietChecks >= 3 && noPendingContent && pageErrorFree && urlStable && stableScrollPosition;
      const decision = searchMode
        ? elapsedMs >= budgetMs ? "QUERY_TIME_BUDGET"
          : atEndOfResults ? "END_OF_RESULTS_CONFIRMED"
            : null
        : core.shouldStopDiscovery({ durationMs: elapsedMs, budgetMs, uniqueCount: records.length, maxPosts: searchMode ? maxDiscoveryPosts : maxPosts, scrolls, maxScrolls, minScrolls, consecutiveNoNew, consecutiveNoVisibleGrowth, consecutiveOldNewPosts });
      if (decision) { stopReason = decision; break; }
      const moved = scrollContainer(container);
      scrolls += 1;
      await wait(moved ? 1600 : 800);
    }

    const durationMs = Math.round(performance.now() - start);
    const finalContainer = findScrollContainer();
    const finalScrollTop = finalContainer === document.scrollingElement ? window.scrollY : finalContainer.scrollTop;
    const finalViewportHeight = finalContainer === document.scrollingElement ? innerHeight : finalContainer.clientHeight;
    const finalReachedBottom = searchMode && isAtEndOfResults(finalContainer);
    const finalPendingContent = searchMode ? pendingSearchContentCount() : 0;
    const finalPageErrorFree = document.readyState === "complete" && !document.querySelector('[data-pagelet="ErrorPage"], [data-testid="page_error"]');
    const finalUrlStable = location.href === discoveryStartUrl;
    const recentIterations = iterations.slice(-3);
    const discoveryEvidence = searchMode ? {
      scrollAttempts: scrolls,
      reachedBottom: finalReachedBottom,
      consecutiveBottomChecks,
      stableScrollPosition: recentIterations.length >= 3 && new Set(recentIterations.map((item) => item.scrollTop)).size === 1,
      urlStable: finalUrlStable,
      pageErrorFree: finalPageErrorFree,
      consecutiveNoGrowthChecks: consecutiveNoNew,
      consecutiveNoVisibleGrowthChecks: consecutiveNoVisibleGrowth,
      networkQuietChecks: recentIterations.filter((item) => item.networkResponsesSinceLastScroll === 0).length,
      noPendingContent: finalPendingContent === 0,
      finalScrollTop: Math.floor(finalScrollTop),
      finalScrollHeight: finalContainer.scrollHeight,
      viewportHeight: Math.floor(finalViewportHeight),
      uniqueTileProgression: iterations.map((item) => item.uniqueTileCount || 0).slice(-10),
    } : undefined;
    const maxVisibleCardCount = Math.max(0, ...iterations.map((item) => item.visibleCardCount));
    const capturedAdvanced = iterations.slice(1).some((item) => item.newIdsThisIteration > 0);
    const visibleFeedAdvancedWithoutCapture = consecutiveVisibleAdvanceWithoutCapture > 0;
    const health = core.evaluateHealth({ visibleCardCount: maxVisibleCardCount, capturedPostCount: records.length, scrolls, durationMs, feedGrew: (iterations.at(-1)?.scrollHeight || 0) > initialHeight, newIdsAfterScroll: capturedAdvanced, visibleFeedAdvanced: visibleFeedAdvancedWithoutCapture, capturedAdvanced: !visibleFeedAdvancedWithoutCapture, stopReason });
    const evidencedRecords = records.map((record) => ({
      ...record,
      discoverySource: searchMode ? "SEARCH" : "MAIN_FEED",
      searchQuery: searchMode ? String(options.searchQuery || "").trim().slice(0, 120) || null : null,
      searchQueries: searchMode && options.searchQuery ? [String(options.searchQuery).trim().slice(0, 120)] : [],
      foundInMainFeed: !searchMode,
      firstSeenPhase: searchMode ? "SEARCH" : "MAIN_FEED",
    }));
    if (!searchMode) {
      for (const post of records) {
        const diagnostic = mainFeedDiagnostics.get(post.postId);
        if (diagnostic) {
          diagnostic.finalIdentity = post.identityConfidence;
          if (post.identityConfidence === "EXACT") diagnostic.failSubstep = null;
        }
      }
    }
    return { source, imageMode, collectedAt: new Date().toISOString(), posts: core.mergeRecords(evidencedRecords, searchMode ? maxDiscoveryPosts : maxPosts), mediaTiles: [...searchMediaTiles.values()].slice(0, maxDiscoveryMediaTiles), rawTilesSeen: rawSearchMediaTilesSeen, uniqueTilesFound: searchObservedMediaIds.size, candidateBufferSize: searchMediaTiles.size, candidateCapReached: searchMediaTiles.size >= maxDiscoveryMediaTiles, scrollCount: scrolls, discoveryDurationMs: Math.round(durationMs), discoveryStopReason: stopReason, discoveryEvidence, health, iterations: iterations.slice(0, 31), ...(searchMode ? { searchResultDiagnostics: [...searchResultDiagnostics.values()].slice(0, 200) } : { mainFeedTelemetry: [...mainFeedDiagnostics.values()].slice(0, 100) }) };
  }

  function collectSearchMediaTiles() {
    const tiles = [];
    for (const anchor of document.querySelectorAll('a[href*="/photo/"][href*="fbid="], a[href*="/photo.php"][href*="fbid="]')) {
      const rect = anchor.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20 || rect.bottom < -500 || rect.top > innerHeight + 2000) continue;
      let url;
      try { url = new URL(anchor.href); } catch { continue; }
      const mediaId = url.searchParams.get("fbid");
      if (url.hostname !== "www.facebook.com" || !/^\d{5,30}$/.test(mediaId || "")) continue;
      const photoUrl = new URL("/photo/", "https://www.facebook.com");
      photoUrl.searchParams.set("fbid", mediaId);
      const mediaSet = url.searchParams.get("set");
      if (/^pcb\.\d{5,30}$/.test(mediaSet || "")) photoUrl.searchParams.set("set", mediaSet);
      tiles.push({ mediaId, photoUrl: photoUrl.toString() });
    }
    return tiles;
  }

  // Search pages often expose a canonical post link and its root story in the
  // result card, while the media payload remains unrelated or redacted. Keep
  // this resolver strictly card-bound: it never walks to neighbours and never
  // promotes a photo id to a post id.
  function collectSearchResultCards(source, query, iteration) {
    const diagnostics = new Map();
    const records = [];
    const mediaSeen = new Set();
    for (const anchor of document.querySelectorAll('a[href]')) {
      const link = core.parsePostLink(anchor.href, source);
      if (!link) continue;
      const key = `${link.postId}|${link.permalink}`;
      const container = findSearchResultContainer(anchor, source, link.postId);
      const evidence = inspectSearchResultCard(container, anchor, link);
      const prior = diagnostics.get(key);
      diagnostics.set(key, prior ? mergeSearchResultDiagnostic(prior, evidence) : evidence);
      if (!container || !evidence.hasCanonicalPostCandidate) continue;
      const author = searchRootAuthor(container);
      const text = searchRootText(container);
      const timestamp = searchRootTimestamp(container);
      const mediaIds = searchCardMediaIds(container);
      const identity = core.resolveRootStoryIdentity({
        rootPostId: link.postId,
        author,
        text,
        rootAuthorSource: author ? "SEARCH_RESULT_CARD_AUTHOR" : null,
        rootTextSource: text ? "SEARCH_RESULT_CARD_MESSAGE" : null,
        rootTextVerified: Boolean(author && text),
      }, link.postId);
      if (identity.identityConfidence !== "EXACT") continue;
      const current = records.find((record) => record.postId === link.postId);
      if (current) {
        current.mediaIds = [...new Set([...(current.mediaIds || []), ...mediaIds])].slice(0, 30);
        continue;
      }
      records.push({
        ...link,
        author: identity.author,
        text: identity.text,
        publishedAt: timestamp?.dateTime || null,
        timestampText: visibleText(timestamp),
        media: [],
        discoveryLayers: ["SEARCH_DOM"],
        firstSeenIteration: iteration,
        rootPostId: link.postId,
        rootAuthorSource: "SEARCH_RESULT_CARD_AUTHOR",
        rootTextSource: "SEARCH_RESULT_CARD_MESSAGE",
        rootTextVerified: true,
        identityConfidence: "EXACT",
        identityReasons: ["SEARCH_RESULT_CARD_CANONICAL_LINK", "ROOT_TEXT_VERIFIED"],
        discoverySource: "SEARCH",
        searchQuery: String(query || "").slice(0, 120) || null,
        searchQueries: query ? [String(query).slice(0, 120)] : [],
        foundInMainFeed: false,
        firstSeenPhase: "SEARCH",
        resolvedFromMediaTile: false,
        mediaIds,
        parentResolutionEvidence: ["SEARCH_RESULT_CARD_CANONICAL_LINK", "SEARCH_RESULT_CARD_ROOT_BINDING"],
      });
      const updated = diagnostics.get(key);
      if (updated) { updated.hasCanonicalPostCandidate = true; updated.firstFailedHop = null; updated.sellIntentCandidate = isLikelySellText(text); }
    }
    // Keep photo-only candidates visible in diagnostics without ever treating
    // their media id as a post id. This is the common unresolved shape on
    // Facebook search pages after media requests are blocked.
    for (const anchor of document.querySelectorAll('a[href*="/photo/"][href*="fbid="], a[href*="/photo.php"][href*="fbid="]')) {
      if (isCommentDescendant(anchor)) continue;
      let mediaId = null;
      try { mediaId = new URL(anchor.href).searchParams.get("fbid"); } catch { /* invalid links are ignored */ }
      if (!/^\d{5,30}$/.test(mediaId || "") || mediaSeen.has(mediaId)) continue;
      mediaSeen.add(mediaId);
      const container = anchor.closest('[role="article"]') || anchor.closest("[data-pagelet]");
      const cardLinks = container ? [...container.querySelectorAll("a[href]")].map((item) => core.parsePostLink(item.href, source)).filter(Boolean) : [];
      if (cardLinks.length > 0) continue;
      const key = `media:${mediaId}`;
      diagnostics.set(key, {
        query: String(query || "").slice(0, 120) || null,
        candidateIndex: 0,
        hasResultContainer: Boolean(container),
        hasAnchor: true,
        anchorHref: safeFacebookHref(anchor.href),
        hasPostIdInHref: false,
        hasStoryFbid: /[?&]story_fbid=\d+/i.test(String(anchor.href || "")),
        hasFtEntIdentifier: Boolean(container?.querySelector?.("[data-ft], [data-entidentifier]")),
        hasTrackingData: Boolean(container?.querySelector?.("[data-tracking], [data-store]")),
        hasAuthor: false,
        hasRootText: false,
        hasTimestamp: false,
        hasStructuredPayload: false,
        hasCanonicalPostCandidate: false,
        postIdCandidate: null,
        permalinkCandidate: null,
        sellIntentCandidate: false,
        firstFailedHop: "ONLY_PHOTO_ID_AVAILABLE",
      });
    }
    return { records: core.mergeRecords(records), diagnostics: [...diagnostics.values()].slice(0, 200).map((diagnostic, candidateIndex) => ({ ...diagnostic, query: String(query || "").slice(0, 120) || null, candidateIndex })) };
  }

  function inspectSearchResultCard(container, anchor, link) {
    const anchorHref = safeFacebookHref(anchor?.href);
    const base = {
      query: null,
      candidateIndex: 0,
      hasResultContainer: Boolean(container),
      hasAnchor: Boolean(anchor),
      anchorHref,
      hasPostIdInHref: Boolean(link?.postId),
      hasStoryFbid: Boolean(anchorHref && /[?&]story_fbid=\d+/i.test(anchorHref)),
      hasFtEntIdentifier: Boolean(container?.querySelector?.("[data-ft], [data-entidentifier], [data-testid*='entidentifier' i]")),
      hasTrackingData: Boolean(container?.querySelector?.("[data-tracking], [data-store], [data-visualcompletion]")),
      hasAuthor: false,
      hasRootText: false,
      hasTimestamp: false,
      hasStructuredPayload: Boolean(container?.querySelector?.("script[type='application/json'], script[type='application/ld+json']")),
      hasCanonicalPostCandidate: false,
      postIdCandidate: link?.postId || null,
      permalinkCandidate: link?.permalink || null,
      sellIntentCandidate: false,
      firstFailedHop: null,
    };
    if (!container) { base.firstFailedHop = "NO_RESULT_CONTAINER"; return base; }
    const links = [...container.querySelectorAll("a[href]")].map((item) => core.parsePostLink(item.href, { ...link, sourceId: link.sourceId, sourceType: link.sourceType })).filter(Boolean);
    const postIds = [...new Set(links.map((item) => item.postId))];
    base.hasCanonicalPostCandidate = postIds.length === 1 && postIds[0] === link.postId;
    base.hasAuthor = Boolean(searchRootAuthor(container));
    const rootText = searchRootText(container);
    base.hasRootText = Boolean(rootText);
    base.sellIntentCandidate = isLikelySellText(rootText);
    base.hasTimestamp = Boolean(searchRootTimestamp(container));
    base.firstFailedHop = !base.hasCanonicalPostCandidate ? "NO_PARENT_LINK_IN_CARD" : !base.hasAuthor ? "AUTHOR_BINDING_MISSING" : !base.hasRootText ? "ROOT_TEXT_BINDING_MISSING" : null;
    return base;
  }

  function mergeSearchResultDiagnostic(previous, current) {
    const merged = { ...previous };
    for (const key of ["hasResultContainer", "hasAnchor", "hasPostIdInHref", "hasStoryFbid", "hasFtEntIdentifier", "hasTrackingData", "hasAuthor", "hasRootText", "hasTimestamp", "hasStructuredPayload", "hasCanonicalPostCandidate", "sellIntentCandidate"]) merged[key] = previous[key] === true || current[key] === true;
    merged.anchorHref ||= current.anchorHref;
    merged.postIdCandidate ||= current.postIdCandidate;
    merged.permalinkCandidate ||= current.permalinkCandidate;
    if (current.hasCanonicalPostCandidate) merged.firstFailedHop = null;
    else if (!merged.firstFailedHop) merged.firstFailedHop = current.firstFailedHop;
    return merged;
  }

  function findSearchResultContainer(anchor, source, postId) {
    const article = anchor.closest('[role="article"]');
    if (article && isBoundSearchCard(article, source, postId)) return article;
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (!isBoundSearchCard(node, source, postId)) continue;
      if (node.hasAttribute("data-pagelet") || node.hasAttribute("data-ft") || node.hasAttribute("data-entidentifier") || node.querySelector("[data-ad-preview='message'], [data-testid='post_message'], [data-ad-comet-preview='message']")) return node;
    }
    return null;
  }

  function isBoundSearchCard(container, source, postId) {
    const links = [...container.querySelectorAll("a[href]")].map((item) => core.parsePostLink(item.href, source)).filter(Boolean);
    const postIds = [...new Set(links.map((item) => item.postId))];
    return postIds.length === 1 && postIds[0] === postId;
  }

  function searchRootAuthor(container) {
    const nodes = [...container.querySelectorAll("h2 a, h3 a, strong a, [role='heading'] a")].filter((node) => !isCommentDescendant(node));
    const names = [...new Set(nodes.map(visibleText).filter(Boolean))];
    return names.length === 1 ? names[0] : null;
  }

  function searchRootText(container) {
    const selectors = "[data-ad-preview='message'], [data-testid='post_message'], [data-ad-comet-preview='message']";
    const nodes = [...container.querySelectorAll(selectors)].filter((node) => !isCommentDescendant(node));
    const texts = [...new Set(nodes.map(visibleText).filter(Boolean))];
    return texts.length === 1 ? texts[0] : null;
  }

  function searchRootTimestamp(container) {
    return [...container.querySelectorAll("abbr, time, a[aria-label*='godz' i], a[aria-label*='min' i], a[aria-label*='dzie' i]")].find((node) => !isCommentDescendant(node)) || null;
  }

  function searchCardMediaIds(container) {
    const ids = [];
    for (const anchor of container.querySelectorAll('a[href*="/photo/"][href*="fbid="], a[href*="/photo.php"][href*="fbid="]')) {
      if (isCommentDescendant(anchor)) continue;
      try { const id = new URL(anchor.href).searchParams.get("fbid"); if (/^\d{5,30}$/.test(id || "")) ids.push(id); } catch { /* invalid links are ignored */ }
    }
    return [...new Set(ids)].slice(0, 30);
  }

  function isLikelySellText(value) { return /\b(?:sprzedam|na\s+sprzeda[zż]|do\s+sprzedania|off\s*market|mam\s+do\s+zaoferowania)\b/i.test(String(value || "")); }
  function safeFacebookHref(value) {
    try {
      const url = new URL(String(value || ""));
      if (!/^https:\/\/(?:www\.)?facebook\.com\//i.test(url.toString())) return null;
      url.search = "";
      url.hash = "";
      return url.toString().slice(0, 2_000);
    } catch { return null; }
  }

  function collectDom(source, iteration, layer) {
    const output = [];
    for (const card of visibleCards()) {
      if (card.parentElement?.closest('[role="article"]')) continue;
      const links = [...card.querySelectorAll('a[href]')].map((anchor) => core.parsePostLink(anchor.href, source)).filter(Boolean);
      const uniqueLinks = [...new Map(links.map((link) => [link.postId, link])).values()];
      if (uniqueLinks.length !== 1) continue;
      const link = uniqueLinks[0];
      const exactElements = (selector) => [...card.querySelectorAll(selector)].filter((node) => node.closest('[role="article"]') === card && !isCommentDescendant(node));
      let messageNodes = exactElements('[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"]');
      const seeMorePresent = hasSeeMore(card);
      const seeMoreClicked = !messageNodes.length && seeMorePresent ? expandRootMessage(card) : false;
      const expandedMessageNodes = exactElements('[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"]');
      const messageCandidates = messageNodes.map((node) => visibleText(node)).filter(Boolean);
      const text = messageCandidates.length === 1 ? messageCandidates[0] : null;
      const rootTextAfterExpand = expandedMessageNodes.map((node) => visibleText(node)).filter(Boolean).length === 1;
      const authorCandidates = exactElements('h2 a, h3 a, strong a').map((node) => visibleText(node)).filter(Boolean);
      const author = authorCandidates[0] || null;
      const timestamp = exactElements('abbr, time, a[aria-label*="godz" i], a[aria-label*="min" i], a[aria-label*="dzie" i]')[0] || null;
      const media = [...card.querySelectorAll('img[src], video[poster]')].flatMap((node) => {
        const url = node.currentSrc || node.src || node.poster;
        if (!url || !/^https:\/\//.test(url)) return [];
        return [{ url, mediaId: mediaIdFromUrl(url), exactPostId: null, exactAssociation: false, discoveryLayers: [layer] }];
      });
      const rootIdentity = core.resolveRootStoryIdentity({ rootPostId: link.postId, author, text, rootAuthorSource: author ? "ROOT_CARD_AUTHOR" : null, rootTextSource: text ? "ROOT_CARD_MESSAGE" : null, rootTextVerified: Boolean(text && author) }, link.postId);
      output.push({ ...link, author: rootIdentity.author || null, text: rootIdentity.text || null, publishedAt: timestamp?.dateTime || null, timestampText: visibleText(timestamp), media, discoveryLayers: [layer], firstSeenIteration: iteration, rootPostId: rootIdentity.rootPostId || link.postId, rootAuthorSource: rootIdentity.rootAuthorSource || null, rootTextSource: rootIdentity.rootTextSource || null, rootTextVerified: rootIdentity.rootTextVerified === true, identityConfidence: rootIdentity.identityConfidence, identityReasons: rootIdentity.identityReasons, __mainFeedDiagnostic: { sourceLayer: "DOM", structuredAuthorPresent: false, structuredTextPresent: false, structuredTextPath: null, rootCardFound: true, rootCardPostIdBound: Boolean(link.postId && uniqueLinks.length === 1), rootCardPermalink: link.permalink, rootAuthorFound: Boolean(author), rootTextFound: Boolean(text), seeMorePresent, seeMoreClicked, rootTextAfterExpand, authorMatch: Boolean(rootIdentity.author && rootIdentity.author === author), postIdMatch: Boolean(rootIdentity.rootPostId === link.postId), finalIdentity: rootIdentity.identityConfidence, failSubstep: rootIdentity.identityConfidence === "EXACT" ? null : !author ? "ROOT_AUTHOR_FOUND" : !text ? "ROOT_TEXT_FOUND" : "IDENTITY_CROSSCHECK" } });
    }
    return core.mergeRecords(output);
  }

  function updateMainFeedDiagnostics(target, records, layer) {
    for (const record of records || []) {
      if (!record?.postId) continue;
      const prior = target.get(record.postId) || emptyMainFeedDiagnostic(record.postId);
      const incoming = record.__mainFeedDiagnostic || {};
      const structured = record.__structuredDiagnostics || {};
      prior.sourceLayer = mergeSourceLayer(prior.sourceLayer, layer);
      prior.structuredAuthorPresent ||= structured.structuredAuthorPresent === true;
      prior.structuredTextPresent ||= structured.structuredTextPresent === true;
      prior.structuredTextPath ||= typeof structured.structuredTextPath === "string" ? structured.structuredTextPath : null;
      prior.rootCardFound ||= incoming.rootCardFound === true;
      prior.rootCardPostIdBound ||= incoming.rootCardPostIdBound === true;
      prior.rootCardPermalink ||= incoming.rootCardPermalink || record.permalink || null;
      prior.rootAuthorFound ||= incoming.rootAuthorFound === true || Boolean(record.author);
      prior.rootTextFound ||= incoming.rootTextFound === true || Boolean(record.text);
      prior.seeMorePresent ||= incoming.seeMorePresent === true;
      prior.seeMoreClicked ||= incoming.seeMoreClicked === true;
      prior.rootTextAfterExpand ||= incoming.rootTextAfterExpand === true;
      prior.authorMatch ||= incoming.authorMatch === true;
      prior.postIdMatch ||= incoming.postIdMatch === true || record.postId === record.rootPostId;
      prior.finalIdentity = record.identityConfidence || incoming.finalIdentity || prior.finalIdentity;
      prior.failSubstep = incoming.failSubstep || record.identityReasons?.[0] || prior.failSubstep;
      target.set(record.postId, prior);
    }
  }

  function emptyMainFeedDiagnostic(postId) { return { postId, sourceLayer: "NETWORK", structuredAuthorPresent: false, structuredTextPresent: false, structuredTextPath: null, rootCardFound: false, rootCardPostIdBound: false, rootCardPermalink: null, rootAuthorFound: false, rootTextFound: false, seeMorePresent: false, seeMoreClicked: false, rootTextAfterExpand: false, authorMatch: false, postIdMatch: false, finalIdentity: "UNVERIFIED", failSubstep: "STRUCTURED_STORY_WITHOUT_ROOT_AUTHOR_OR_TEXT" }; }
  function mergeSourceLayer(previous, current) { if (!previous) return current; if (previous === current) return previous; if (previous === "BOTH" || current === "BOTH") return "BOTH"; return "BOTH"; }

  function isCommentDescendant(node) {
    return Boolean(node.closest('[data-testid*="comment" i], [aria-label*="comment" i], [aria-label*="komentarz" i]'));
  }

  function expandRootMessage(card) {
    const buttons = [...card.querySelectorAll('div[role="button"], button, a[role="button"]')]
      .filter((node) => node.closest('[role="article"]') === card)
      .filter((node) => /zobacz wi[eę]cej|see more/i.test(visibleText(node) || node.getAttribute('aria-label') || ''));
    if (buttons.length === 1) { buttons[0].click(); return true; }
    return false;
  }
  function hasSeeMore(card) { return [...card.querySelectorAll('div[role="button"], button, a[role="button"]')].some((node) => node.closest('[role="article"]') === card && /zobacz wi[eÄ™]cej|see more/i.test(visibleText(node) || node.getAttribute('aria-label') || '')); }

  function collectHydration(source, iteration, layer) {
    const records = [];
    let bytes = 0;
    for (const script of [...document.scripts].slice(0, 250)) {
      const body = script.textContent || "";
      if (!body || bytes + body.length > 4_000_000) continue;
      bytes += body.length;
      records.push(...core.extractStructuredRecordsFromText(body, layer, source, iteration));
    }
    return core.mergeRecords(records);
  }

  function visibleCards() {
    return [...document.querySelectorAll('[role="article"]')].filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.width > 250 && rect.height > 80 && rect.bottom >= -1000 && rect.top <= innerHeight + 2500;
    });
  }
  function visibleText(node) { return node?.innerText?.replace(/\s+/g, " ").trim().slice(0, 20_000) || null; }
  function visibleString(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 20_000) || null : null; }
  function cardFingerprint(card) { const link = card.querySelector('a[href*="/posts/"], a[href*="story_fbid="]')?.href || ""; const text = visibleText(card)?.slice(0, 160) || ""; return link || text ? `${link}|${text}` : null; }
  function findScrollContainer() {
    const candidates = [document.scrollingElement, ...document.querySelectorAll('[role="feed"], [data-pagelet*="Feed"]')].filter(Boolean);
    return candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || document.documentElement;
  }
  function scrollContainer(container) {
    const before = container === document.scrollingElement ? window.scrollY : container.scrollTop;
    if (container === document.scrollingElement) window.scrollBy({ top: Math.max(innerHeight * 0.85, 700), behavior: "instant" });
    else container.scrollBy({ top: Math.max(container.clientHeight * 0.85, 700), behavior: "instant" });
    const after = container === document.scrollingElement ? window.scrollY : container.scrollTop;
    return after >= before;
  }
  function isAtEndOfResults(container) {
    const position = container === document.scrollingElement ? window.scrollY : container.scrollTop;
    const viewport = container === document.scrollingElement ? innerHeight : container.clientHeight;
    return position + viewport >= container.scrollHeight - 32;
  }
  function pendingSearchContentCount() {
    return document.querySelectorAll('[aria-busy="true"], [data-visualcompletion="loading-state"]').length;
  }
  function mediaIdFromUrl(value) { return value.match(/(?:fbid=|\/)(\d{8,30})(?:[/?&_.-]|$)/)?.[1] || null; }
  function ids(records) { return [...new Set(records.map((record) => record.postId))].slice(0, 20); }
  function clamp(value, min, max, fallback) { return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback; }
  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
  function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
})();
