(function installGeckoPocContent(scope) {
  "use strict";
  // Content script of the GeckoView POC. It connects to the app over the
  // official native-messaging port and acts only on the app's requests:
  // "probe" (page diagnostics) and "scan" (post ids of the approved group).
  // No fetch/XHR, no gallery, no clicks, no form access: it reads the DOM the
  // user already sees. Input values are never read; only element counts.
  const adapter = scope.FlipGeckoPocAdapter;
  const core = scope.FlipFacebookCollectorCore;
  let port;
  try {
    port = browser.runtime.connectNative("flipPoc");
  } catch {
    return;
  }
  let scanning = false;

  // Dynamic-loading / virtualization evidence: element nodes added and
  // removed since this content script started, plus a 10-second window.
  // Counts only; no node is kept.
  const loadedAt = Date.now();
  const loadDocument = scope.document;
  const mutations = { added: 0, removed: 0, recent: [] };
  try {
    new MutationObserver(records => {
      let added = 0;
      let removed = 0;
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeType === 1) added++;
        for (const node of record.removedNodes) if (node.nodeType === 1) removed++;
      }
      if (!added && !removed) return;
      mutations.added += added;
      mutations.removed += removed;
      const now = Date.now();
      mutations.recent.push([now, added, removed]);
      while (mutations.recent.length && now - mutations.recent[0][0] > 10_000) mutations.recent.shift();
    }).observe(scope.document.documentElement, { childList: true, subtree: true });
  } catch { /* diagnostics only */ }

  // Plain inline scripts (no src) and JSON scripts: Facebook page data.
  function pageDataTexts() {
    let total = 0;
    const texts = [];
    for (const script of Array.from(scope.document.querySelectorAll("script:not([src])")).slice(0, 400)) {
      const text = script.textContent || "";
      if (!text || text.length > 2_000_000 || total + text.length > 8_000_000) continue;
      total += text.length;
      texts.push(text);
      if (texts.length >= 120) break;
    }
    return texts;
  }

  function networkEvidence(accepted, withRecords) {
    try {
      return browser.runtime.sendMessage({ type: "networkEvidence", accepted, withRecords }).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function probe() {
    const doc = scope.document;
    return {
      host: scope.location.hostname,
      path: scope.location.pathname.slice(0, 200),
      title: String(doc.title || "").slice(0, 120),
      readyState: doc.readyState,
      elements: doc.getElementsByTagName("*").length,
      forms: doc.forms.length,
      inputs: doc.querySelectorAll("input").length,
      passwordInputs: doc.querySelectorAll('input[type="password"]').length,
      articles: topLevelCards().length,
      iframes: doc.querySelectorAll("iframe").length,
    };
  }

  // Facebook's own identifiers of the shown group, for the "Diagnoza grupy" check (no posts, no text).
  function groupProbe() {
    const doc = scope.document;
    const segment = (scope.location.pathname.match(/^\/groups\/([^/]+)\/?$/) || [])[1] || null;
    const ids = adapter.groupIdentity({
      metaTags: Array.from(doc.querySelectorAll('meta[property^="al:"]')).slice(0, 40).map(meta => ({ property: meta.getAttribute("property"), content: meta.getAttribute("content") })),
      alternateLinks: Array.from(doc.querySelectorAll('link[rel="alternate"][href]')).slice(0, 40).map(link => link.getAttribute("href")),
      scriptTexts: Array.from(doc.querySelectorAll('script[type="application/json"]')).slice(0, 100).map(script => script.textContent || ""),
    });
    return { host: scope.location.hostname, segment, ids };
  }

  function topLevelCards() {
    const all = Array.from(scope.document.querySelectorAll('[role="article"],article'));
    return all.filter(card => !card.parentElement || !card.parentElement.closest('[role="article"],article'));
  }

  function snapshot() {
    const doc = scope.document;
    const cards = topLevelCards().slice(0, 300).map(card => ({
      // Only the card's own links; links inside nested cards (comments) are left out.
      hrefs: Array.from(card.querySelectorAll("a[href]"))
        .filter(a => a.closest('[role="article"],article') === card)
        .map(a => a.href)
        .slice(0, 200),
    }));
    const structured = pageDataTexts();
    return {
      href: scope.location.href,
      bodyTextSample: String((doc.body && (doc.body.innerText || doc.body.textContent)) || "").slice(0, 4000),
      hasPasswordInput: Boolean(doc.querySelector('input[type="password"]')),
      hasLoginForm: Boolean(doc.querySelector('form[action*="login"]')),
      hasCaptcha: Boolean(doc.querySelector('iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"]')),
      cards,
      structured,
    };
  }

  // Count-only topology of the visible document. Same-origin iframe / open
  // shadow observations are used strictly as DIAGNOSTICS, never as post sources.
  // Cross-origin or closed trees remain inaccessible; no bypass is attempted.
  function domTopology(doc) {
    const result = {
      iframeCount: 0, iframeReadable: 0, iframeInaccessible: 0,
      iframeAnchors: 0, iframeArticles: 0,
      openShadowRoots: 0, openShadowAnchors: 0, openShadowArticles: 0
    };
    const frames = Array.from(doc.querySelectorAll("iframe")).slice(0, 30);
    result.iframeCount = frames.length;
    for (const frame of frames) {
      try {
        const inner = frame.contentDocument;
        // Never recurse into nested frames. No URLs or text are read.
        if (!inner) { result.iframeInaccessible++; continue; }
        result.iframeReadable++;
        result.iframeAnchors += Math.min(600, inner.querySelectorAll("a[href]").length);
        result.iframeArticles += Math.min(600, inner.querySelectorAll('article,[role="article"]').length);
      } catch {
        result.iframeInaccessible++;
      }
    }
    for (const element of Array.from(doc.querySelectorAll("*")).slice(0, 5000)) {
      const root = element.shadowRoot;
      if (!root || result.openShadowRoots >= 30) continue;
      result.openShadowRoots++;
      result.openShadowAnchors += Math.min(600, root.querySelectorAll("a[href]").length);
      result.openShadowArticles += Math.min(600, root.querySelectorAll('article,[role="article"]').length);
    }
    return result;
  }

  // A one-off read-only DOM refresh. No page text, links, post IDs, image
  // content or credentials are sent to Android. Do not turn these candidates
  // into posts; only the separately authorized scan may do that.
  function domDiagnosis(groupId) {
    const doc = scope.document;
    const all = Array.from(doc.querySelectorAll("a[href]")).slice(0, 600);
    const wrappers = new Set();
    for (const a of all) {
      const parent = a.closest('[role="article"],article,[data-pagelet],[data-testid]');
      if (parent) wrappers.add(parent);
    }
    return adapter.inspectDomLinks({
      href: scope.location.href,
      hasCaptcha: Boolean(doc.querySelector('iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"]')),
      hasPasswordInput: Boolean(doc.querySelector('input[type="password"]')),
      hasLoginForm: Boolean(doc.querySelector('form[action*="login"]')),
      anchors: all.map(a => a.href),
      roleArticles: doc.querySelectorAll('[role="article"]').length,
      nativeArticles: doc.querySelectorAll("article").length,
      roleFeeds: doc.querySelectorAll('[role="feed"]').length,
      candidateWrappers: wrappers.size,
      structuredScripts: doc.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]').length,
      ...domTopology(doc),
    }, { groupId, aliases: [], maxPosts: 20 }, core);
  }

  // One count-only report that separates the possible causes of NO_POSTS:
  // wrong document/context, no post markup, no permalinks, dynamic loading /
  // virtualization, and whether any layer carries an exact post id. Only
  // numbers and attribute NAMES leave the page; never text, values or ids.
  async function structureDiagnosis(groupId, allowLoopback) {
    const doc = scope.document;
    const input = { groupId, aliases: [], maxPosts: 20, allowLoopback: allowLoopback === true };
    const page = snapshot();
    const state = adapter.classify(page, input);
    if (state !== "GROUP_OK") return { status: state, counters: {}, attributeNames: [] };
    const accepted = [groupId];
    const n = selector => Math.min(99999, doc.querySelectorAll(selector).length);
    const counters = {};

    // Context: is the rendered screen this document?
    const points = [[0.5, 0.3], [0.5, 0.5], [0.5, 0.7], [0.25, 0.5], [0.75, 0.5]];
    counters.ctxPointsSampled = points.length;
    counters.ctxPointsInDocument = points.filter(([x, y]) => {
      const element = doc.elementFromPoint((scope.innerWidth || 1) * x, (scope.innerHeight || 1) * y);
      return Boolean(element && element.ownerDocument === doc && doc.documentElement.contains(element));
    }).length;
    counters.ctxSameDocumentAsLoad = doc === loadDocument ? 1 : 0;
    counters.ctxVisible = doc.visibilityState === "visible" ? 1 : 0;
    counters.ctxElements = n("*");
    counters.ctxScrollHeightPx = Math.min(999999, Math.round(doc.documentElement.scrollHeight || 0));
    counters.ctxViewportHeightPx = Math.min(99999, Math.round(scope.innerHeight || 0));
    counters.ctxSecondsSinceLoad = Math.min(99999, Math.round((Date.now() - loadedAt) / 1000));

    // Post markup: classic and mobile-framework markers.
    counters.roleArticles = n('[role="article"]');
    counters.nativeArticles = n("article");
    counters.roleFeeds = n('[role="feed"]');
    counters.mComponents = n("[data-mcomponent]");
    counters.mContainers = n('[data-mcomponent="MContainer"]');
    counters.dataTypeContainers = n('[data-type="container"]');
    counters.trackingIds = n("[data-tracking-duration-id]");
    counters.actionIds = n("[data-action-id]");
    counters.focusables = n("[data-focusable]");
    counters.dataFt = n("[data-ft]");
    counters.dataStore = n("[data-store]");
    counters.dataSigil = n("[data-sigil]");
    counters.roleButtons = n('[role="button"]');
    counters.tabIndexed = n("[tabindex]");
    counters.images = n("img");
    counters.largeImages = Math.min(99999, Array.from(doc.images).slice(0, 2000).filter(img => (img.getBoundingClientRect().width || 0) >= 200).length);

    // Permalinks: real links, and post-like URLs held in other attributes.
    const anchors = Array.from(doc.querySelectorAll("a[href]")).slice(0, 2000);
    counters.anchors = anchors.length;
    let anchorPost = 0;
    let anchorForeign = 0;
    for (const a of anchors) {
      const link = core.parsePostLink(a.href);
      if (!link || link.sourceType !== "GROUP") continue;
      if (accepted.includes(link.sourceId)) anchorPost++; else anchorForeign++;
    }
    counters.anchorGroupPostLinks = anchorPost;
    counters.anchorForeignPostLinks = anchorForeign;
    let attrPost = 0;
    let attrPostAccepted = 0;
    const names = new Map();
    for (const element of Array.from(doc.querySelectorAll("*")).slice(0, 20000)) {
      for (const attribute of Array.from(element.attributes)) {
        if (/^(data-|aria-|role$|tabindex$)/.test(attribute.name)) names.set(attribute.name, (names.get(attribute.name) || 0) + 1);
        if (attribute.name === "href" && element.tagName === "A") continue;
        const value = attribute.value;
        if (!value || value.length > 4000 || !/\/posts\/|\/permalink\/|story_fbid/.test(value)) continue;
        attrPost++;
        const url = (value.match(/https?:\/\/[^\s"'<>]+|\/(?:groups|story\.php)[^\s"'<>]*/) || [])[0];
        const link = url ? core.parsePostLink(url) : null;
        if (link && link.sourceType === "GROUP" && accepted.includes(link.sourceId)) attrPostAccepted++;
      }
    }
    counters.attrPostLikeValues = Math.min(99999, attrPost);
    counters.attrGroupPostLinks = Math.min(99999, attrPostAccepted);
    const attributeNames = [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .filter(([name]) => /^[a-z][a-z0-9-]{0,40}$/.test(name)).map(([name, count]) => ({ name, count: Math.min(99999, count) }));

    // Dynamic loading / virtualization.
    counters.mutAddedTotal = Math.min(999999, mutations.added);
    counters.mutRemovedTotal = Math.min(999999, mutations.removed);
    const now = Date.now();
    const recent = mutations.recent.filter(entry => now - entry[0] <= 10_000);
    counters.mutAdded10s = Math.min(999999, recent.reduce((sum, entry) => sum + entry[1], 0));
    counters.mutRemoved10s = Math.min(999999, recent.reduce((sum, entry) => sum + entry[2], 0));

    // Identifiers: exact ids per layer, plus raw key counts.
    counters.domExactIds = adapter.evaluate({ ...page, structured: [], networkRecords: [] }, input, core).posts.length;
    const texts = pageDataTexts();
    counters.inlineScripts = texts.length;
    counters.inlineScriptKb = Math.round(texts.reduce((sum, text) => sum + text.length, 0) / 1024);
    const keys = adapter.countIdKeys(texts, accepted);
    counters.scriptKeyPostId = keys.postId;
    counters.scriptKeyTopLevel = keys.topLevel;
    counters.scriptKeyStoryFbid = keys.storyFbid;
    counters.scriptGroupPermalinks = keys.groupPermalinks;
    counters.scriptExactIds = adapter.exactStructuredIds(texts, accepted, core, "HYDRATION").length;
    const network = await networkEvidence(accepted, false);
    Object.assign(counters, (network && network.counts) || { netFilterAvailable: 0 });
    counters.netAnswered = network ? 1 : 0;

    const verdict = adapter.structureVerdict(counters);
    counters.virtualizationSuspected = verdict.virtualized;
    return { status: "GROUP_OK", verdict: verdict.code, counters, attributeNames };
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function scan(request) {
    const input = { groupId: request.groupId, aliases: Array.isArray(request.aliases) ? request.aliases : [], maxPosts: request.maxPosts, allowLoopback: request.allowLoopback === true };
    const startHref = scope.location.href;
    const scrolls = Math.max(0, Math.min(5, Math.floor(Number(request.scrolls) || 0)));
    const pauseMs = Math.max(200, Math.min(4000, Math.floor(Number(request.scrollPauseMs) || 1500)));
    let scrolled = 0;
    for (let i = 0; i < scrolls; i++) {
      // Stop at once when the page left the approved group.
      if (adapter.classify(snapshot(), input) !== "GROUP_OK") break;
      scope.scrollBy(0, Math.max(400, scope.innerHeight || 800));
      scrolled++;
      await sleep(pauseMs);
    }
    if (scope.location.href !== startHref && adapter.classify(snapshot(), input) !== "GROUP_OK") {
      return { status: "NAVIGATED_AWAY", posts: [], diagnostics: {}, scrolls: scrolled };
    }
    const accepted = [input.groupId, ...input.aliases];
    const network = await networkEvidence(accepted, true);
    const page = snapshot();
    page.networkRecords = network && Array.isArray(network.records) ? network.records : [];
    const result = adapter.evaluate(page, input, core);
    return { ...result, scrolls: scrolled };
  }

  port.onMessage.addListener(async message => {
    if (!message || typeof message !== "object" || typeof message.nonce !== "string") return;
    if (message.type === "probe") {
      port.postMessage({ type: "probeResult", nonce: message.nonce, probe: probe() });
      return;
    }
    if (message.type === "domDiagnosis") {
      // The native caller must explicitly supply the one approved source.
      // This path never invokes scan(), snapshot() or post extraction.
      const result = domDiagnosis(message.groupId);
      port.postMessage({ type: "domDiagnosisResult", nonce: message.nonce, probe: probe(), ...result });
      return;
    }
    if (message.type === "structureDiagnosis") {
      // Count-only: never calls scan() and never consumes the one-shot scan permission.
      let result;
      try { result = await structureDiagnosis(message.groupId, message.allowLoopback === true); }
      catch (error) { result = { status: "DIAGNOSIS_ERROR", counters: {}, attributeNames: [] }; }
      port.postMessage({ type: "structureDiagnosisResult", nonce: message.nonce, ...result });
      return;
    }
    if (message.type === "groupProbe") {
      port.postMessage({ type: "groupProbeResult", nonce: message.nonce, group: groupProbe() });
      return;
    }
    if (message.type !== "scan") return;
    if (scanning) {
      port.postMessage({ type: "scanResult", nonce: message.nonce, status: "BUSY", posts: [], diagnostics: {} });
      return;
    }
    scanning = true;
    try {
      const result = await scan(message);
      port.postMessage({ type: "scanResult", nonce: message.nonce, probe: probe(), ...result });
    } catch (error) {
      port.postMessage({ type: "scanResult", nonce: message.nonce, status: "COLLECTOR_ERROR", error: String((error && error.message) || error).slice(0, 120), posts: [], diagnostics: {} });
    } finally {
      scanning = false;
    }
  });

  port.postMessage({ type: "ready", probe: probe() });
})(globalThis);
