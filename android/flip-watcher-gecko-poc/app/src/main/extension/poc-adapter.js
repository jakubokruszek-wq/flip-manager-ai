(function installGeckoPocAdapter(scope) {
  "use strict";
  // Pure decision layer of the GeckoView POC. It never touches the DOM, the
  // network or browser APIs: poc-content.js turns the page into a snapshot and
  // this file decides, with the unchanged collector-core.js, which post ids are
  // exactly identified. Node tests run it on plain objects.

  const FACEBOOK_HOSTS = ["www.facebook.com", "m.facebook.com", "facebook.com"];
  const LOOPBACK_HOST = "127.0.0.1";
  const MAX_POSTS_LIMIT = 20;
  const UNAVAILABLE_TEXT = /content isn't available|this content isn't available|group is private|join group to see|ta zawartość jest niedostępna|ta treść jest niedostępna|dołącz do grupy, aby/i;

  // Page state from the location and a few DOM facts, in the order the pilot
  // uses: a verification page always wins over everything else.
  function classify(snapshot, input) {
    const url = safeUrl(snapshot && snapshot.href);
    if (!url) return "WRONG_GROUP";
    const host = url.hostname.toLowerCase();
    const loopback = input && input.allowLoopback === true && host === LOOPBACK_HOST && url.protocol === "http:";
    if (!loopback && (url.protocol !== "https:" || !FACEBOOK_HOSTS.includes(host))) return "WRONG_GROUP";
    const path = url.pathname;
    if (/checkpoint|two_step_verification/i.test(path)) return "CHECKPOINT";
    if (/captcha/i.test(path) || snapshot.hasCaptcha === true) return "CAPTCHA";
    if (/^\/(login|recover)/i.test(path) || snapshot.hasPasswordInput === true || snapshot.hasLoginForm === true) return "LOGIN_REQUIRED";
    if (UNAVAILABLE_TEXT.test(String(snapshot.bodyTextSample || ""))) return "GROUP_UNAVAILABLE";
    if (!input || !isGroupId(input.groupId)) return "WRONG_GROUP";
    const segment = path.match(/^\/groups\/([^/]+)\/?$/);
    if (!segment || !acceptedIds(input).includes(segment[1])) return "WRONG_GROUP";
    return "GROUP_OK";
  }

  // The numeric id plus only the aliases the app sends as verified for it.
  // There is never a general acceptance of /groups/ paths.
  function acceptedIds(input) {
    const aliases = Array.isArray(input && input.aliases) ? input.aliases.filter(isGroupId).slice(0, 5) : [];
    return [input.groupId, ...aliases.filter(alias => alias !== input.groupId)];
  }

  function evaluate(snapshot, input, core) {
    if (!core) throw Error("COLLECTOR_CORE_MISSING");
    const maxPosts = Math.max(1, Math.min(MAX_POSTS_LIMIT, Math.floor(Number(input && input.maxPosts) || MAX_POSTS_LIMIT)));
    const diagnostics = { visibleCards: 0, structuredScripts: 0, structuredRecords: 0, networkRecords: 0, cardsWithoutId: 0, ambiguousCards: 0, foreignCards: 0, duplicatesDropped: 0, overLimitDropped: 0 };
    const state = classify(snapshot, input);
    if (state !== "GROUP_OK") return { status: state, posts: [], diagnostics };

    const groupId = input.groupId;
    const accepted = acceptedIds(input);
    const canonical = postId => `https://www.facebook.com/groups/${groupId}/posts/${postId}/`;
    const records = [];

    // Page data (JSON and plain inline scripts): identity comes only from the
    // core, which binds a story id to a permalink of an accepted group.
    const structuredTexts = (snapshot.structured || []).filter(text => typeof text === "string").slice(0, 120);
    diagnostics.structuredScripts = structuredTexts.length;
    for (const record of exactStructuredIds(structuredTexts, accepted, core, "HYDRATION")) {
      diagnostics.structuredRecords++;
      records.push({ ...record, sourceId: groupId, sourceType: "GROUP", idSource: "STRUCTURED" });
    }

    // Network layer: records the background already bound with the core. They
    // are re-validated here; anything not an exact accepted-group link is dropped.
    for (const record of (Array.isArray(snapshot.networkRecords) ? snapshot.networkRecords : []).slice(0, 500)) {
      const postId = record && typeof record.postId === "string" ? record.postId : "";
      const link = record && typeof record.permalink === "string" ? core.parsePostLink(record.permalink) : null;
      if (!/^\d{5,30}$/.test(postId) || !link || link.sourceType !== "GROUP" || link.postId !== postId || !accepted.includes(link.sourceId)) continue;
      diagnostics.networkRecords++;
      records.push({ postId, permalink: canonical(postId), sourceId: groupId, sourceType: "GROUP", idSource: "NETWORK" });
    }

    // Top-level cards: a card counts only with exactly one post id among its
    // own links, all of them in an accepted id (comments and nested cards are
    // excluded by the snapshot).
    const cards = (snapshot.cards || []).slice(0, 300);
    diagnostics.visibleCards = cards.length;
    for (const card of cards) {
      const parsed = (card.hrefs || []).map(href => core.parsePostLink(href)).filter(link => link && link.sourceType === "GROUP");
      const links = parsed.filter(link => accepted.includes(link.sourceId));
      const foreign = parsed.filter(link => !accepted.includes(link.sourceId));
      const ids = [...new Set(links.map(link => link.postId))];
      // A card that also links a post of another group (e.g. a share) is ambiguous, never ours.
      if (ids.length === 1 && !foreign.length) {
        records.push({ postId: ids[0], permalink: canonical(ids[0]), sourceId: groupId, sourceType: "GROUP", idSource: "DOM_LINK" });
      } else if (ids.length >= 1) diagnostics.ambiguousCards++;
      else if (foreign.length) diagnostics.foreignCards++;
      else diagnostics.cardsWithoutId++;
    }

    const merged = core.mergeRecords(records, 10_000);
    diagnostics.duplicatesDropped = records.length - merged.length;
    const posts = [];
    for (const post of merged) {
      // Re-check the canonical link: only exact ids of this group survive.
      const link = core.parsePostLink(post.permalink, { sourceType: "GROUP", sourceId: groupId, allowGroupRedirect: false });
      if (!link || link.postId !== post.postId || link.sourceId !== groupId || !/^\d{5,30}$/.test(post.postId)) continue;
      const layers = records.filter(record => record.postId === post.postId).map(record => record.idSource);
      posts.push({ postId: post.postId, permalink: link.permalink, idSource: ["STRUCTURED", "NETWORK", "DOM_LINK"].find(layer => layers.includes(layer)) });
    }
    diagnostics.overLimitDropped = Math.max(0, posts.length - maxPosts);
    const limited = posts.slice(0, maxPosts);
    return { status: limited.length ? "OK" : "NO_POSTS", posts: limited, diagnostics };
  }

  // Exact ids from Facebook data texts (page scripts or network bodies): the
  // core accepts a story only with its own permalink in the same node, for an
  // accepted group, with allowGroupRedirect=false. Canonical identity is the
  // approved group (accepted[0]). Never guesses from a bare number.
  function exactStructuredIds(texts, accepted, core, layer) {
    const ids = new Map();
    if (!core || !Array.isArray(accepted) || !accepted.length) return [];
    for (const text of (texts || []).slice(0, 120)) {
      if (typeof text !== "string" || !text) continue;
      for (const id of accepted) {
        const source = { sourceType: "GROUP", sourceId: id, sourceUrl: `https://www.facebook.com/groups/${id}/`, allowGroupRedirect: false };
        let found = [];
        try { found = core.extractStructuredRecordsFromText(text, layer, source, 0) || []; } catch { found = []; }
        for (const record of found) {
          if (/^\d{5,30}$/.test(record.postId) && !ids.has(record.postId)) ids.set(record.postId, { postId: record.postId, permalink: `https://www.facebook.com/groups/${accepted[0]}/posts/${record.postId}/` });
        }
      }
    }
    return [...ids.values()];
  }

  // How often id-carrying keys and permalinks of an accepted group appear in
  // the texts, escaped or not. Counts only; no value is returned.
  function countIdKeys(texts, accepted) {
    const escaped = (accepted || []).map(id => String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const groupLink = escaped ? new RegExp(`groups(?:\\\\?/)(?:${escaped})(?:\\\\?/)(?:posts|permalink)(?:\\\\?/)\\d{5,30}`, "g") : null;
    const counts = { postId: 0, topLevel: 0, storyFbid: 0, groupPermalinks: 0 };
    const count = (text, re) => { let n = 0; for (const _ of text.matchAll(re)) { if (++n >= 99999) break; } return n; };
    for (const raw of (texts || []).slice(0, 120)) {
      if (typeof raw !== "string") continue;
      const text = raw.slice(0, 4_000_000);
      counts.postId += count(text, /\\?"post_id\\?"\s*:/g);
      counts.topLevel += count(text, /top_level_post_id/g);
      counts.storyFbid += count(text, /story_fbid/g);
      if (groupLink) counts.groupPermalinks += count(text, groupLink);
    }
    for (const key of Object.keys(counts)) counts[key] = Math.min(99999, counts[key]);
    return counts;
  }

  // One verdict from the structure counters, most basic cause first. Codes are
  // a fixed list the app whitelists.
  function structureVerdict(c) {
    const n = key => Math.max(0, Number(c && c[key]) || 0);
    // Network bodies are never read (0.2.2): exact ids can come only from the DOM and page scripts.
    const exact = { DOM: n("domExactIds"), SCRIPT: n("scriptExactIds"), NETWORK: 0 };
    const keys = n("scriptKeyPostId") + n("scriptKeyTopLevel") + n("scriptKeyStoryFbid") + n("scriptGroupPermalinks");
    const markup = n("roleArticles") + n("nativeArticles") + n("mComponents") + n("trackingIds") + n("dataFt");
    const virtualized = n("mutAdded10s") >= 50 && n("mutRemoved10s") * 2 >= n("mutAdded10s") ? 1 : 0;
    let code;
    if (n("ctxPointsSampled") > 0 && n("ctxPointsInDocument") * 2 < n("ctxPointsSampled")) code = "WRONG_DOCUMENT_OR_CONTEXT";
    else if (exact.DOM + exact.SCRIPT + exact.NETWORK > 0) code = "EXACT_IDS_AVAILABLE";
    else if (keys > 0) code = "ID_KEYS_WITHOUT_EXACT_BINDING";
    else if (n("netCountingActive") === 1 && n("netWindowSec") > 0 && n("netReqTotal") === 0) code = "NETWORK_NOT_OBSERVED_YET";
    // Content kept arriving over the network during the window while neither the
    // DOM nor page scripts carry an id: the ids (if any) are only in response
    // bodies, which this POC deliberately does not read.
    else if (n("netCountingActive") === 1 && n("netReqTotal") > 0 && n("mutAdded10s") + n("mutAddedTotal") >= 200) code = "FEED_DATA_NOT_CAPTURED";
    else if (markup === 0 && n("images") === 0) code = "NO_POST_MARKUP";
    else code = "NO_POST_IDS_IN_PAGE_DATA";
    return { code, virtualized, exactDom: exact.DOM, exactScript: exact.SCRIPT, exactNetwork: exact.NETWORK };
  }

  // ---- network traffic counter (aggregate numbers only, never content)
  //
  // Counts requests to Facebook hosts during ONE explicitly armed window, for
  // ONE tab showing the approved group. Nothing is counted while unarmed.
  // Requests of the armed tab are split by resource type; requests with no
  // tab (service worker / browser) are counted separately by type and are
  // never attributed to the group. No URL, query, header or body is kept:
  // only a fixed set of type counters and allowlisted first path segments.
  const TRAFFIC_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "script", "websocket", "image", "media", "ping", "beacon", "other"];
  const TRAFFIC_TYPE_KEYS = { main_frame: "MainFrame", sub_frame: "SubFrame", xmlhttprequest: "Xhr", script: "Script", websocket: "Websocket", image: "Image", media: "Media", ping: "Ping", beacon: "Beacon", other: "Other" };
  const PATH_ALLOWLIST = new Set(["flip-control", "api", "ajax", "async", "groups", "bz", "rsrc.php", "security", "sw", "login", "checkpoint", "video", "photo", "stories", "dialog", "plugins", "tr", "ufi", "ds", "data"]);
  const MAX_TRAFFIC_WINDOW_MS = 30_000;

  function trafficPathSegment(url) {
    let segment = "";
    try { segment = (new URL(url).pathname.split("/")[1] || "").toLowerCase(); } catch { return "(inne)"; }
    return PATH_ALLOWLIST.has(segment) ? "/" + segment : "(inne)";
  }

  // Host class of a request, never the host name itself: Facebook pages/APIs,
  // Facebook's media CDN (post images), the POC's own control endpoint on
  // 127.0.0.1, other loopback fixture pages, or nothing (ignored).
  const CONTROL_PATH = "/flip-control";
  function trafficHostClass(url) {
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === "https:" && (host === "facebook.com" || host.endsWith(".facebook.com"))) return "facebook";
    if (parsed.protocol === "https:" && host.endsWith(".fbcdn.net")) return "fbcdn";
    if (parsed.protocol === "http:" && host === "127.0.0.1") return parsed.pathname.startsWith(CONTROL_PATH) ? "control" : "loopback";
    return null;
  }

  function createTrafficCounter(now = () => Date.now()) {
    let scope = null;
    const empty = () => ({
      tab: new Map(), noTab: new Map(), paths: new Map(), withTab: 0, noTabTotal: 0,
      fbcdnTab: 0, fbcdnNoTab: 0, otherTab: 0, completedTab: 0, fromCacheTab: 0,
      controlTab: 0, controlNoTab: 0, controlOtherTab: 0,
    });
    let counts = empty();
    return {
      arm(tabId, windowMs) {
        if (!Number.isInteger(tabId) || tabId < 0) return false;
        const ms = Math.max(0, Math.min(MAX_TRAFFIC_WINDOW_MS, Math.floor(Number(windowMs) || 0)));
        scope = { tabId, until: now() + ms + 2_000 };
        counts = empty();
        return true;
      },
      isArmed() { return Boolean(scope) && now() <= scope.until; },
      armedTab() { return this.isArmed() ? scope.tabId : null; },
      record(details) {
        if (!this.isArmed() || !details) return false;
        const hostClass = trafficHostClass(details.url);
        if (!hostClass) return false;
        // Unknown resource types (imageset, font, speculative…) are counted as "other", not dropped.
        const type = TRAFFIC_TYPES.includes(details.type) ? details.type : "other";
        if (hostClass === "control") {
          if (details.tabId === scope.tabId) counts.controlTab++;
          else if (details.tabId === -1) counts.controlNoTab++;
          else counts.controlOtherTab++;
          return true;
        }
        if (details.tabId === scope.tabId) {
          // A new top-level document in the armed tab ends the scope at once.
          if (type === "main_frame") { this.disarm(); return false; }
          if (hostClass === "fbcdn") { counts.fbcdnTab++; return true; }
          counts.withTab++;
          counts.tab.set(type, (counts.tab.get(type) || 0) + 1);
          const segment = trafficPathSegment(details.url);
          counts.paths.set(segment, (counts.paths.get(segment) || 0) + 1);
          return true;
        }
        if (details.tabId === -1) {
          if (hostClass === "fbcdn") { counts.fbcdnNoTab++; return true; }
          counts.noTabTotal++;
          counts.noTab.set(type, (counts.noTab.get(type) || 0) + 1);
          return true;
        }
        // Another tab: one total only (no type, path or host), to detect tab-id mismatch.
        counts.otherTab++;
        return false;
      },
      // onCompleted of the armed tab: whether the response came from the cache.
      complete(details) {
        if (!this.isArmed() || !details || details.tabId !== scope.tabId || !trafficHostClass(details.url)) return false;
        counts.completedTab++;
        if (details.fromCache === true) counts.fromCacheTab++;
        return true;
      },
      // Read once, by the armed tab only; then the scope and counts are cleared.
      read(tabId, api = {}) {
        if (!scope || tabId !== scope.tabId) return null;
        const cap = value => Math.min(999_999, value || 0);
        const out = {
          netCountingActive: 1, netBodyCapture: 0,
          netReqTotal: cap(counts.withTab + counts.noTabTotal), netReqWithTab: cap(counts.withTab), netReqNoTab: cap(counts.noTabTotal),
          netFbcdnTab: cap(counts.fbcdnTab), netFbcdnNoTab: cap(counts.fbcdnNoTab), netOtherTabTotal: cap(counts.otherTab),
          netCompletedTab: cap(counts.completedTab), netFromCacheTab: cap(counts.fromCacheTab),
          controlTab: cap(counts.controlTab), controlNoTab: cap(counts.controlNoTab), controlOtherTab: cap(counts.controlOtherTab),
          apiWebRequest: api.webRequest ? 1 : 0, apiListener: api.listener ? 1 : 0, apiOnCompleted: api.onCompleted ? 1 : 0,
        };
        for (const type of TRAFFIC_TYPES) {
          out["netTab" + TRAFFIC_TYPE_KEYS[type]] = cap(counts.tab.get(type));
          out["netNoTab" + TRAFFIC_TYPE_KEYS[type]] = cap(counts.noTab.get(type));
        }
        const requestPaths = [...counts.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
        this.disarm();
        return { counts: out, requestPaths };
      },
      disarm() { scope = null; counts = empty(); },
    };
  }

  // ---- 0.2.4: measurement of ONE approved group page load, from before navigation
  //
  // Armed by the app (not by a page) BEFORE loadUri. The first main_frame
  // request to the approved group (Facebook host or, in tests, loopback)
  // within BIND_MS binds the measurement to that tab. From then on only that
  // tab is counted, by host class and type; tab-less requests are counted
  // apart and never attributed; other tabs give one total. A later top-level
  // navigation of the bound tab to login, checkpoint/CAPTCHA, another group
  // or another host FREEZES the counters with that reason: the measurement
  // never extends to any other page. Counts only; no URL, query, header or body.
  const LOAD_BIND_MS = 10_000;
  const LOAD_MAX_WINDOW_MS = 30_000;
  const LOAD_STOPS = ["LOGIN", "CHECKPOINT", "CAPTCHA", "OTHER_GROUP", "OTHER_HOST", "OTHER_PAGE"];

  function loadTarget(url, accepted) {
    let parsed;
    try { parsed = new URL(url); } catch { return "OTHER_HOST"; }
    const hostClass = trafficHostClass(url);
    if (hostClass !== "facebook" && hostClass !== "loopback") return "OTHER_HOST";
    const path = parsed.pathname;
    if (/checkpoint|two_step_verification/i.test(path)) return "CHECKPOINT";
    if (/captcha/i.test(path)) return "CAPTCHA";
    if (/^\/(login|recover)/i.test(path)) return "LOGIN";
    const group = (path.match(/^\/groups\/([^/]+)\/?$/) || [])[1];
    if (group) return accepted.includes(group) ? "APPROVED" : "OTHER_GROUP";
    return "OTHER_PAGE";
  }

  function createLoadCounter(now = () => Date.now()) {
    let m = null;
    const fresh = (nonce, accepted, windowMs) => ({
      nonce, accepted, armedAt: now(), windowMs, tabId: null, stop: null,
      mainFrames: 0, docCompleted: 0,
      page: new Map(), pageTotal: 0, fbcdn: new Map(), fbcdnTotal: 0, noTab: 0, noTabFbcdn: 0, otherTab: 0,
      completed: 0, fromCache: 0, paths: new Map(),
    });
    const live = () => m && now() <= m.armedAt + m.windowMs + 2_000;
    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    return {
      arm(nonce, accepted, windowMs) {
        const ids = (Array.isArray(accepted) ? accepted : []).filter(id => typeof id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(id)).slice(0, 6);
        if (typeof nonce !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(nonce) || !ids.length) return false;
        const ms = Math.max(1_000, Math.min(LOAD_MAX_WINDOW_MS, Math.floor(Number(windowMs) || 0)));
        m = fresh(nonce, ids, ms);
        return true;
      },
      isArmed() { return Boolean(live()); },
      boundTab() { return m ? m.tabId : null; },
      record(details) {
        if (!live() || !details) return false;
        const hostClass = trafficHostClass(details.url);
        // Leaving for a non-watched host still freezes the bound tab (when the event is delivered).
        if (!hostClass && m.tabId !== null && details.tabId === m.tabId && details.type === "main_frame" && !m.stop) { m.stop = "OTHER_HOST"; return false; }
        if (!hostClass || hostClass === "control") return false;
        const type = TRAFFIC_TYPES.includes(details.type) ? details.type : "other";
        if (m.tabId === null) {
          // Bind only to the first main_frame of the approved group, shortly after arming.
          if (type !== "main_frame" || details.tabId < 0 || now() - m.armedAt > LOAD_BIND_MS) return false;
          if (loadTarget(details.url, m.accepted) !== "APPROVED") return false;
          m.tabId = details.tabId;
        } else if (details.tabId !== m.tabId) {
          if (details.tabId === -1) { if (hostClass === "fbcdn") m.noTabFbcdn++; else m.noTab++; return true; }
          m.otherTab++;
          return false;
        }
        if (m.stop) return false; // frozen: nothing after leaving the approved page
        if (type === "main_frame") {
          const target = loadTarget(details.url, m.accepted);
          if (target !== "APPROVED") { m.stop = target; return false; }
          m.mainFrames++;
        }
        if (hostClass === "fbcdn") { m.fbcdnTotal++; bump(m.fbcdn, type); return true; }
        m.pageTotal++;
        bump(m.page, type);
        bump(m.paths, trafficPathSegment(details.url));
        return true;
      },
      complete(details) {
        if (!live() || !details || m.tabId === null || details.tabId !== m.tabId || m.stop) return false;
        const hostClass = trafficHostClass(details.url);
        if (!hostClass || hostClass === "control") return false;
        m.completed++;
        if (details.fromCache === true) m.fromCache++;
        if (details.type === "main_frame" && loadTarget(details.url, m.accepted) === "APPROVED") m.docCompleted = 1;
        return true;
      },
      // Read once with the arming nonce; the measurement is cleared afterwards.
      read(nonce) {
        if (!m || nonce !== m.nonce) return null;
        const cap = value => Math.min(999_999, value || 0);
        const out = {
          loadArmed: 1, loadBound: m.tabId === null ? 0 : 1, loadMainFrames: cap(m.mainFrames), loadDocCompleted: m.docCompleted,
          loadWindowSec: Math.round(m.windowMs / 1000), loadBodyCapture: 0,
          loadPageTotal: cap(m.pageTotal), loadFbcdnTotal: cap(m.fbcdnTotal),
          loadNoTab: cap(m.noTab), loadNoTabFbcdn: cap(m.noTabFbcdn), loadOtherTab: cap(m.otherTab),
          loadCompleted: cap(m.completed), loadFromCache: cap(m.fromCache),
        };
        for (const type of TRAFFIC_TYPES) {
          out["loadPage" + TRAFFIC_TYPE_KEYS[type]] = cap(m.page.get(type));
          out["loadFbcdn" + TRAFFIC_TYPE_KEYS[type]] = cap(m.fbcdn.get(type));
        }
        const stopReason = m.stop;
        const requestPaths = [...m.paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
        m = null;
        return { counts: out, stopReason, requestPaths };
      },
      abort(nonce) { if (m && (nonce === undefined || nonce === m.nonce)) { m = null; return true; } return false; },
    };
  }

  // Control-test result from its counters (or null when the extension never answered).
  function controlVerdict(counts) {
    if (!counts) return "TIMEOUT";
    const n = key => Math.max(0, Number(counts[key]) || 0);
    if (n("controlTab") >= 2) return "LISTENER_OK";
    if (n("controlOtherTab") + n("controlNoTab") > 0) return "WRONG_TAB";
    return "LISTENER_NOT_OBSERVED";
  }

  // Count-only, read-only inspection for the current mobile Facebook DOM.
  // This NEVER produces a post record, canonical link, guessed ID, or a scan
  // request; it cannot consume a one-shot scan permission.
  function inspectDomLinks(snapshot, input, core) {
    const zero = {
      anchorsSeen: 0, exactGroupLinks: 0, exactGroupIds: 0,
      foreignGroupLinks: 0, photoLinks: 0, otherLinks: 0,
      roleArticles: 0, nativeArticles: 0, roleFeeds: 0,
      candidateWrappers: 0, structuredScripts: 0,
      iframeCount: 0, iframeReadable: 0, iframeInaccessible: 0,
      iframeAnchors: 0, iframeArticles: 0,
      openShadowRoots: 0, openShadowAnchors: 0, openShadowArticles: 0
    };
    const state = classify({ href: snapshot && snapshot.href,
      hasCaptcha: snapshot && snapshot.hasCaptcha,
      hasPasswordInput: snapshot && snapshot.hasPasswordInput,
      hasLoginForm: snapshot && snapshot.hasLoginForm,
      bodyTextSample: "" }, input);
    if (state !== "GROUP_OK" || !core || typeof core.parsePostLink !== "function") {
      return { status: state === "GROUP_OK" ? "NOT_READY" : state, counters: zero };
    }
    const anchors = (Array.isArray(snapshot.anchors) ? snapshot.anchors : []).slice(0, 600);
    const ids = new Set();
    const counters = { ...zero,
      anchorsSeen: anchors.length,
      roleArticles: Math.min(9999, Math.max(0, Number(snapshot.roleArticles) || 0)),
      nativeArticles: Math.min(9999, Math.max(0, Number(snapshot.nativeArticles) || 0)),
      roleFeeds: Math.min(9999, Math.max(0, Number(snapshot.roleFeeds) || 0)),
      candidateWrappers: Math.min(9999, Math.max(0, Number(snapshot.candidateWrappers) || 0)),
      structuredScripts: Math.min(9999, Math.max(0, Number(snapshot.structuredScripts) || 0)),
      iframeCount: Math.min(9999, Math.max(0, Number(snapshot.iframeCount) || 0)),
      iframeReadable: Math.min(9999, Math.max(0, Number(snapshot.iframeReadable) || 0)),
      iframeInaccessible: Math.min(9999, Math.max(0, Number(snapshot.iframeInaccessible) || 0)),
      iframeAnchors: Math.min(9999, Math.max(0, Number(snapshot.iframeAnchors) || 0)),
      iframeArticles: Math.min(9999, Math.max(0, Number(snapshot.iframeArticles) || 0)),
      openShadowRoots: Math.min(9999, Math.max(0, Number(snapshot.openShadowRoots) || 0)),
      openShadowAnchors: Math.min(9999, Math.max(0, Number(snapshot.openShadowAnchors) || 0)),
      openShadowArticles: Math.min(9999, Math.max(0, Number(snapshot.openShadowArticles) || 0))
    };
    const accepted = acceptedIds(input);
    for (const value of anchors) {
      if (typeof value !== "string" || value.length > 2048) continue;
      const url = safeUrl(value);
      if (!url || !FACEBOOK_HOSTS.includes(url.hostname.toLowerCase()) || url.protocol !== "https:") {
        counters.otherLinks++;
        continue;
      }
      if (url.pathname === "/photo" || url.pathname.startsWith("/photo/") ||
          url.pathname === "/photo.php" || url.pathname.startsWith("/photo.php/")) counters.photoLinks++;
      const parsed = core.parsePostLink(value);
      if (!parsed || parsed.sourceType !== "GROUP") { counters.otherLinks++; continue; }
      if (!accepted.includes(parsed.sourceId)) { counters.foreignGroupLinks++; continue; }
      counters.exactGroupLinks++;
      ids.add(parsed.postId);
    }
    counters.exactGroupIds = ids.size;
    return { status: "GROUP_OK", counters };
  }

  // Numeric group ids Facebook itself publishes for the shown page: app-link
  // metadata ("strong") and page JSON ("weak", feeds also mention other groups).
  function groupIdentity(meta) {
    const hits = [];
    const add = (id, source) => { if (/^\d{5,30}$/.test(id) && hits.length < 50) hits.push({ id, source }); };
    for (const item of (meta && meta.metaTags) || []) {
      const property = String(item.property || "");
      if (!["al:android:url", "al:ios:url"].includes(property)) continue;
      const match = String(item.content || "").match(/^fb:\/\/group\/(?:\?id=)?(\d{5,30})(?:[/?#]|$)/i);
      if (match) add(match[1], property);
    }
    for (const href of (meta && meta.alternateLinks) || []) {
      const match = String(href).match(/^(android-app|ios-app):\/\/[^\s]*?fb:?\/?\/?group\/(?:\?id=)?(\d{5,30})(?:[/?#]|$)/i);
      if (match) add(match[2], match[1].toLowerCase());
    }
    const counts = new Map();
    for (const text of ((meta && meta.scriptTexts) || []).slice(0, 100)) {
      for (const match of String(text).slice(0, 2_000_000).matchAll(/"(?:groupID|group_id)"\s*:\s*"(\d{5,30})"/g)) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
    for (const [id, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) hits.push({ id, source: `json×${count}` });
    return hits;
  }

  function isGroupId(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value); }
  function safeUrl(value) { try { return new URL(value); } catch { return null; } }

  scope.FlipGeckoPocAdapter = { classify, evaluate, inspectDomLinks, groupIdentity, exactStructuredIds, countIdKeys, structureVerdict, createTrafficCounter, trafficPathSegment, trafficHostClass, controlVerdict, createLoadCounter, loadTarget, LOAD_STOPS, MAX_POSTS_LIMIT };
})(globalThis);
