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
    const exact = { DOM: n("domExactIds"), SCRIPT: n("scriptExactIds"), NETWORK: n("netExactIds") };
    const keys = n("scriptKeyPostId") + n("scriptKeyTopLevel") + n("scriptKeyStoryFbid") + n("scriptGroupPermalinks") + n("netKeyPostId") + n("netKeyTopLevel") + n("netKeyStoryFbid") + n("netGroupPermalinks");
    const markup = n("roleArticles") + n("nativeArticles") + n("mComponents") + n("trackingIds") + n("dataFt");
    const virtualized = n("mutAdded10s") >= 50 && n("mutRemoved10s") * 2 >= n("mutAdded10s") ? 1 : 0;
    let code;
    if (n("ctxPointsSampled") > 0 && n("ctxPointsInDocument") * 2 < n("ctxPointsSampled")) code = "WRONG_DOCUMENT_OR_CONTEXT";
    else if (exact.DOM + exact.SCRIPT + exact.NETWORK > 0) code = "EXACT_IDS_AVAILABLE";
    else if (keys > 0) code = "ID_KEYS_WITHOUT_EXACT_BINDING";
    else if (n("netFilterAvailable") === 1 && n("netResponses") === 0) code = "NETWORK_NOT_OBSERVED_YET";
    // The page grew a lot while (almost) no Facebook response was read: the
    // feed data travels where the network layer does not look yet.
    else if (n("netFilterAvailable") === 1 && n("netResponses") <= 3 && n("mutAddedTotal") >= 200) code = "FEED_DATA_NOT_CAPTURED";
    else if (markup === 0 && n("images") === 0) code = "NO_POST_MARKUP";
    else code = "NO_POST_IDS_IN_PAGE_DATA";
    return { code, virtualized, exactDom: exact.DOM, exactScript: exact.SCRIPT, exactNetwork: exact.NETWORK };
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

  scope.FlipGeckoPocAdapter = { classify, evaluate, inspectDomLinks, groupIdentity, exactStructuredIds, countIdKeys, structureVerdict, MAX_POSTS_LIMIT };
})(globalThis);
