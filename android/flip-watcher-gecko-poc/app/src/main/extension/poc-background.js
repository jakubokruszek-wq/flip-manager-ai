(function installGeckoPocBackground(scope) {
  "use strict";
  // Network layer of the POC, the same idea as network-hook.js of the Chrome
  // collector: Facebook's own responses to the user's session carry post ids
  // that the mobile DOM does not show as links. Every response is passed to
  // the page UNCHANGED (filter.write first, always); a copy is kept only in
  // this extension's memory, bounded and short-lived, and only when it can
  // contain post identifiers. No body, text, cookie or header ever leaves the
  // extension: callers get counts, or (for an authorized scan) ids and
  // canonical permalinks that collector-core.js bound exactly to the group.
  const core = scope.FlipFacebookCollectorCore;
  const MAX_BODY_CHARS = 2_000_000;
  const MAX_HELD_CHARS = 12_000_000;
  const MAX_HELD = 40;
  const TTL_MS = 20 * 60 * 1000;
  const MAYBE_IDS = /post_id|top_level_post_id|story_fbid|\/posts\/|\/permalink\//;
  // Bodies are kept per tab (GeckoSession) and only for its current
  // document: a new top-level page load drops what the tab held before.
  const held = new Map();
  const stats = { responses: 0, truncated: 0, errors: 0, filterAvailable: 0 };
  // Where Facebook's traffic actually flows (counts only): every request to a
  // Facebook host, by resource type, by whether it belongs to a tab (a request
  // with tabId -1 comes from a service worker or the browser itself), and by
  // the first path segment ("/api", "/ajax"…). No URL, query or body is kept.
  const traffic = { total: 0, withTab: 0, noTab: 0, types: new Map(), paths: new Map() };
  const NO_TAB = -1;

  function heldFor(tabId) {
    const now = Date.now();
    const items = (held.get(tabId) || []).filter(item => now - item.at <= TTL_MS);
    held.set(tabId, items);
    return items;
  }

  function remember(tabId, text) {
    if (!MAYBE_IDS.test(text)) return;
    const items = heldFor(tabId);
    items.push({ at: Date.now(), text });
    let total = items.reduce((sum, item) => sum + item.text.length, 0);
    while (items.length > MAX_HELD || total > MAX_HELD_CHARS) total -= items.shift().text.length;
  }

  if (scope.browser && browser.webRequest) {
    browser.webRequest.onBeforeRequest.addListener(details => {
      traffic.total++;
      if (details.tabId >= 0) traffic.withTab++; else traffic.noTab++;
      traffic.types.set(details.type, (traffic.types.get(details.type) || 0) + 1);
      let segment = "?";
      try { segment = "/" + (new URL(details.url).pathname.split("/")[1] || ""); } catch { /* counted as "?" */ }
      if (!/^\/[a-z0-9_.-]{0,24}$/i.test(segment)) segment = "/(inne)";
      if (traffic.paths.size < 60 || traffic.paths.has(segment)) traffic.paths.set(segment, (traffic.paths.get(segment) || 0) + 1);
    }, { urls: ["https://*.facebook.com/*", "https://facebook.com/*", "http://127.0.0.1/*"] });
  }

  if (scope.browser && browser.webRequest && typeof browser.webRequest.filterResponseData === "function") {
    stats.filterAvailable = 1;
    browser.webRequest.onBeforeRequest.addListener(details => {
      if (details.type === "main_frame") held.delete(details.tabId);
      let filter;
      try { filter = browser.webRequest.filterResponseData(details.requestId); } catch { stats.errors++; return; }
      const decoder = new TextDecoder("utf-8");
      let text = "";
      let full = false;
      filter.ondata = event => {
        filter.write(event.data);
        if (full) return;
        try {
          text += decoder.decode(event.data, { stream: true });
          if (text.length > MAX_BODY_CHARS) { text = text.slice(0, MAX_BODY_CHARS); full = true; stats.truncated++; }
        } catch { full = true; stats.errors++; }
      };
      filter.onstop = () => {
        try { filter.close(); } catch { /* already closed */ }
        stats.responses++;
        try { if (!full) text += decoder.decode(); remember(details.tabId, text); } catch { stats.errors++; }
      };
      filter.onerror = () => { stats.errors++; };
    }, {
      urls: ["https://www.facebook.com/*", "https://m.facebook.com/*", "https://web.facebook.com/*", "http://127.0.0.1/*"],
      // Data may arrive as XHR/fetch, as a script response, as a sub-document or
      // from a service worker ("other", tabId -1); all are read, none is altered.
      types: ["main_frame", "sub_frame", "xmlhttprequest", "script", "other"],
    }, ["blocking"]);
  }

  function evidence(tabId, accepted, withRecords) {
    // Requests without a tab (service worker) cannot be tied to a tab; they are
    // included, and collector-core still accepts only the approved group.
    const items = heldFor(tabId).concat(tabId === NO_TAB ? [] : heldFor(NO_TAB));
    const counts = { netFilterAvailable: stats.filterAvailable, netResponses: stats.responses, netHeld: items.length, netKb: 0, netTruncated: stats.truncated, netErrors: stats.errors };
    const keys = FlipGeckoPocAdapter.countIdKeys(items.map(item => item.text), accepted);
    counts.netKb = Math.round(items.reduce((sum, item) => sum + item.text.length, 0) / 1024);
    counts.netKeyPostId = keys.postId;
    counts.netKeyTopLevel = keys.topLevel;
    counts.netKeyStoryFbid = keys.storyFbid;
    counts.netGroupPermalinks = keys.groupPermalinks;
    const records = FlipGeckoPocAdapter.exactStructuredIds(items.map(item => item.text), accepted, core, "NETWORK");
    counts.netExactIds = records.length;
    counts.netReqTotal = traffic.total;
    counts.netReqWithTab = traffic.withTab;
    counts.netReqNoTab = traffic.noTab;
    for (const [type, key] of [["main_frame", "netReqMainFrame"], ["sub_frame", "netReqSubFrame"], ["xmlhttprequest", "netReqXhr"], ["script", "netReqScript"], ["websocket", "netReqWebsocket"], ["image", "netReqImage"], ["media", "netReqMedia"], ["ping", "netReqPing"], ["beacon", "netReqBeacon"], ["other", "netReqOther"]]) counts[key] = traffic.types.get(type) || 0;
    const requestPaths = [...traffic.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
    return withRecords ? { counts, records, requestPaths } : { counts, requestPaths };
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || message.type !== "networkEvidence" || !sender || !sender.tab) return undefined;
    const accepted = (Array.isArray(message.accepted) ? message.accepted : []).filter(id => typeof id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(id)).slice(0, 6);
    if (!accepted.length) return Promise.resolve({ counts: {} });
    return Promise.resolve(evidence(sender.tab.id, accepted, message.withRecords === true));
  });
})(globalThis);
