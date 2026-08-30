(function installPageCollector() {
  "use strict";
  const core = globalThis.FlipFacebookCollectorCore;
  if (!core || globalThis.__flipCollectorContent) return;
  globalThis.__flipCollectorContent = true;
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
    if (message?.type === "RESOLVE_SEARCH_MEDIA_TILE") { respond({ ok: true, result: resolveSearchMediaTile(message.options || {}) }); return false; }
    if (message?.type !== "COLLECT_SOURCE") return false;
    void collectSource(message.options || {}).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  });

  function resolveSearchMediaTile(options) {
    const mediaId = String(options.mediaId || "");
    const source = core.canonicalSource(options.sourceUrl);
    const current = new URL(location.href);
    if (!source || source.sourceType !== "GROUP" || !/^\d{5,30}$/.test(mediaId)) return { status: "UNVERIFIED", records: [], reasons: ["SEARCH_MEDIA_RESOLVE_INPUT_INVALID"] };
    if (!/^\/photo(?:\.php)?(?:\/|$)/i.test(current.pathname) || current.searchParams.get("fbid") !== mediaId) return { status: "UNVERIFIED", records: [], reasons: ["SEARCH_MEDIA_TILE_CONTEXT_MISMATCH"] };
    const candidates = [];
    let bytes = 0;
    for (const script of [...document.scripts].slice(0, 250)) {
      const body = script.textContent || "";
      if (!body || bytes + body.length > 4_000_000) continue;
      bytes += body.length;
      candidates.push(...core.resolveSearchMediaParentFromText(body, "SEARCH_MEDIA_RESOLVE", source, mediaId, 0));
    }
    const verified = core.verifySearchMediaParent(candidates, mediaId);
    if (verified.status !== "VERIFIED") return verified;
    const records = verified.records.map((record) => ({ ...record, discoverySource: "SEARCH", foundInMainFeed: false, firstSeenPhase: "SEARCH", searchQuery: String(options.searchQuery || "").slice(0, 120) || null, searchQueries: options.searchQuery ? [String(options.searchQuery).slice(0, 120)] : [] }));
    return { ...verified, records };
  }

  async function collectSource(options) {
    const source = core.canonicalSource(location.href);
    if (!source) throw new Error("FACEBOOK_SOURCE_URL_REQUIRED");
    const maxScrolls = clamp(options.maxScrolls, 0, 30, 30);
    const minScrolls = clamp(options.minScrolls, 0, maxScrolls, 3);
    const maxPosts = clamp(options.maxPosts, 1, 50, 50);
    const maxMediaTiles = clamp(options.maxMediaTiles, 1, 100, 10);
    const budgetMs = clamp(options.budgetMs, 5_000, 120_000, 110_000);
    const searchMode = options.searchMode === true;
    const layerPrefix = searchMode ? "SEARCH_" : "";
    const start = performance.now();
    const iterations = [];
    let records = [];
    const searchMediaTiles = new Map();
    let scrolls = 0;
    let consecutiveNoNew = 0;
    let consecutiveNoVisibleGrowth = 0;
    let consecutiveOldNewPosts = 0;
    let previousVisibleFingerprints = new Set();
    let consecutiveVisibleAdvanceWithoutCapture = 0;
    const initialHeight = document.documentElement.scrollHeight;
    let previousNetworkResponses = networkResponses;
    let stopReason = "MAX_SCROLLS";

    for (let iteration = 0; ; iteration += 1) {
      if (searchMode) for (const tile of collectSearchMediaTiles()) searchMediaTiles.set(tile.mediaId, tile);
      const dom = collectDom(source, iteration, `${layerPrefix}DOM`);
      const hydration = collectHydration(source, iteration, `${layerPrefix}HYDRATION`);
      const network = [...networkRecords.values()].map((record) => ({ ...record, firstSeenIteration: record.firstSeenIteration ?? iteration, discoveryLayers: [`${layerPrefix}NETWORK`] }));
      const beforeIds = new Set(records.map((record) => record.postId));
      const before = records.length;
      records = core.mergeRecords([...records, ...dom, ...hydration, ...network], maxPosts);
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
      iterations.push({ iteration, domPostIds: ids(dom), hydrationPostIds: ids(hydration), networkPostIds: ids(network), mergedPostIds: ids(records), visibleCardCount: cards.length, newVisibleCardsThisIteration: newVisibleCards, scrollTop: Math.floor(scrollTop), scrollHeight, newIdsThisIteration: added, consecutiveOldNewPosts, networkResponsesSinceLastScroll: networkResponses - previousNetworkResponses });
      previousNetworkResponses = networkResponses;
      const decision = searchMode && scrolls >= minScrolls && searchMediaTiles.size >= maxMediaTiles ? "MAX_SEARCH_MEDIA_TILES" : core.shouldStopDiscovery({ durationMs: performance.now() - start, budgetMs, uniqueCount: records.length, maxPosts, scrolls, maxScrolls, minScrolls, consecutiveNoNew, consecutiveNoVisibleGrowth, consecutiveOldNewPosts });
      if (decision) { stopReason = decision; break; }
      const moved = scrollContainer(container);
      scrolls += 1;
      await wait(moved ? 1600 : 800);
    }

    const durationMs = Math.round(performance.now() - start);
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
    return { source, collectedAt: new Date().toISOString(), posts: core.mergeRecords(evidencedRecords, maxPosts), mediaTiles: [...searchMediaTiles.values()].slice(0, 100), health, iterations: iterations.slice(0, 31) };
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

  function collectDom(source, iteration, layer) {
    const output = [];
    for (const card of visibleCards()) {
      if (card.parentElement?.closest('[role="article"]')) continue;
      const links = [...card.querySelectorAll('a[href]')].map((anchor) => core.parsePostLink(anchor.href, source)).filter(Boolean);
      const uniqueLinks = [...new Map(links.map((link) => [link.postId, link])).values()];
      if (uniqueLinks.length !== 1) continue;
      const link = uniqueLinks[0];
      const exactElements = (selector) => [...card.querySelectorAll(selector)].filter((node) => node.closest('[role="article"]') === card);
      const messageCandidates = exactElements('[data-ad-preview="message"], [data-testid="post_message"], [data-ad-comet-preview="message"]').map((node) => visibleText(node)).filter(Boolean);
      const text = messageCandidates.length === 1 ? messageCandidates[0] : null;
      const authorCandidates = exactElements('h2 a, h3 a, strong a').map((node) => visibleText(node)).filter(Boolean);
      const author = authorCandidates[0] || null;
      const timestamp = exactElements('abbr, time, a[aria-label*="godz" i], a[aria-label*="min" i], a[aria-label*="dzie" i]')[0] || null;
      const media = [...card.querySelectorAll('img[src], video[poster]')].flatMap((node) => {
        const url = node.currentSrc || node.src || node.poster;
        if (!url || !/^https:\/\//.test(url)) return [];
        return [{ url, mediaId: mediaIdFromUrl(url), exactPostId: null, exactAssociation: false, discoveryLayers: [layer] }];
      });
      const exactIdentity = Boolean(text && author);
      output.push({ ...link, author, text, publishedAt: timestamp?.dateTime || null, timestampText: visibleText(timestamp), media, discoveryLayers: [layer], firstSeenIteration: iteration, identityConfidence: exactIdentity ? "EXACT" : "UNVERIFIED", identityReasons: exactIdentity ? ["DOM_EXACT_TOP_LEVEL_POST_CARD"] : ["DOM_EXACT_AUTHOR_MESSAGE_NOT_PROVEN"] });
    }
    return core.mergeRecords(output);
  }

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
  function mediaIdFromUrl(value) { return value.match(/(?:fbid=|\/)(\d{8,30})(?:[/?&_.-]|$)/)?.[1] || null; }
  function ids(records) { return [...new Set(records.map((record) => record.postId))].slice(0, 20); }
  function clamp(value, min, max, fallback) { return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback; }
  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
})();
