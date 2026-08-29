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
    if (message?.type !== "COLLECT_SOURCE") return false;
    void collectSource(message.options || {}).then((result) => respond({ ok: true, result })).catch((error) => respond({ ok: false, error: safeError(error) }));
    return true;
  });

  async function collectSource(options) {
    const source = core.canonicalSource(location.href);
    if (!source) throw new Error("FACEBOOK_SOURCE_URL_REQUIRED");
    const maxScrolls = clamp(options.maxScrolls, 0, 10, 10);
    const minScrolls = clamp(options.minScrolls, 0, maxScrolls, 3);
    const maxPosts = clamp(options.maxPosts, 1, 20, 20);
    const budgetMs = clamp(options.budgetMs, 5_000, 90_000, 75_000);
    const searchMode = options.searchMode === true;
    const layerPrefix = searchMode ? "SEARCH_" : "";
    const start = performance.now();
    const iterations = [];
    let records = [];
    let scrolls = 0;
    let consecutiveNoNew = 0;
    const initialHeight = document.documentElement.scrollHeight;
    let previousNetworkResponses = networkResponses;
    let stopReason = "MAX_SCROLLS";

    for (let iteration = 0; ; iteration += 1) {
      const dom = collectDom(source, iteration, `${layerPrefix}DOM`);
      const hydration = collectHydration(source, iteration, `${layerPrefix}HYDRATION`);
      const network = [...networkRecords.values()].map((record) => ({ ...record, firstSeenIteration: record.firstSeenIteration ?? iteration, discoveryLayers: [`${layerPrefix}NETWORK`] }));
      const before = records.length;
      records = core.mergeRecords([...records, ...dom, ...hydration, ...network], maxPosts);
      const added = records.length - before;
      consecutiveNoNew = added === 0 ? consecutiveNoNew + 1 : 0;
      const container = findScrollContainer();
      const scrollTop = container === document.scrollingElement ? window.scrollY : container.scrollTop;
      const scrollHeight = container.scrollHeight;
      iterations.push({ iteration, domPostIds: ids(dom), hydrationPostIds: ids(hydration), networkPostIds: ids(network), mergedPostIds: ids(records), visibleCardCount: visibleCards().length, scrollTop: Math.floor(scrollTop), scrollHeight, newIdsThisIteration: added, networkResponsesSinceLastScroll: networkResponses - previousNetworkResponses });
      previousNetworkResponses = networkResponses;
      const decision = core.shouldStopDiscovery({ durationMs: performance.now() - start, budgetMs, uniqueCount: records.length, maxPosts, reliableAgeCutoff: false, scrolls, maxScrolls, minScrolls, consecutiveNoNew });
      if (decision) { stopReason = decision; break; }
      const moved = scrollContainer(container);
      scrolls += 1;
      await wait(moved ? 1600 : 800);
    }

    const durationMs = Math.round(performance.now() - start);
    const maxVisibleCardCount = Math.max(0, ...iterations.map((item) => item.visibleCardCount));
    const health = core.evaluateHealth({ visibleCardCount: maxVisibleCardCount, capturedPostCount: records.length, scrolls, durationMs, feedGrew: (iterations.at(-1)?.scrollHeight || 0) > initialHeight, newIdsAfterScroll: iterations.slice(1).some((item) => item.newIdsThisIteration > 0), stopReason });
    return { source, collectedAt: new Date().toISOString(), posts: records, health, iterations: iterations.slice(0, 11) };
  }

  function collectDom(source, iteration, layer) {
    const output = [];
    for (const card of visibleCards()) {
      const links = [...card.querySelectorAll('a[href]')].map((anchor) => core.parsePostLink(anchor.href, source)).filter(Boolean);
      const uniqueLinks = [...new Map(links.map((link) => [link.postId, link])).values()];
      if (uniqueLinks.length !== 1) continue;
      const link = uniqueLinks[0];
      const text = visibleText(card);
      const author = [...card.querySelectorAll('h2 a, h3 a, strong a, a[role="link"]')].map((node) => visibleText(node)).find(Boolean) || null;
      const timestamp = card.querySelector('abbr, time, a[aria-label*="godz" i], a[aria-label*="min" i], a[aria-label*="dzie" i]');
      const media = [...card.querySelectorAll('img[src], video[poster]')].flatMap((node) => {
        const url = node.currentSrc || node.src || node.poster;
        if (!url || !/^https:\/\//.test(url)) return [];
        return [{ url, mediaId: mediaIdFromUrl(url), exactPostId: null, exactAssociation: false, discoveryLayers: [layer] }];
      });
      output.push({ ...link, author, text, publishedAt: timestamp?.dateTime || null, timestampText: visibleText(timestamp), media, discoveryLayers: [layer], firstSeenIteration: iteration });
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
