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
    const diagnostics = { visibleCards: 0, structuredScripts: 0, structuredRecords: 0, cardsWithoutId: 0, ambiguousCards: 0, foreignCards: 0, duplicatesDropped: 0, overLimitDropped: 0 };
    const state = classify(snapshot, input);
    if (state !== "GROUP_OK") return { status: state, posts: [], diagnostics };

    const groupId = input.groupId;
    const accepted = acceptedIds(input);
    const canonical = postId => `https://www.facebook.com/groups/${groupId}/posts/${postId}/`;
    const records = [];

    // Structured (hydration) payloads: identity comes only from the core, run
    // once per accepted id with allowGroupRedirect=false (no foreign groups).
    for (const text of (snapshot.structured || []).slice(0, 100)) {
      if (typeof text !== "string" || text.length > 2_000_000) continue;
      diagnostics.structuredScripts++;
      for (const id of accepted) {
        const source = { sourceType: "GROUP", sourceId: id, sourceUrl: `https://www.facebook.com/groups/${id}/`, allowGroupRedirect: false };
        const found = core.extractStructuredRecordsFromText(text, "HYDRATION", source, 0) || [];
        diagnostics.structuredRecords += found.length;
        for (const record of found) records.push({ postId: record.postId, permalink: canonical(record.postId), sourceId: groupId, sourceType: "GROUP", idSource: "STRUCTURED" });
      }
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
      posts.push({ postId: post.postId, permalink: link.permalink, idSource: layers.includes("STRUCTURED") ? "STRUCTURED" : "DOM_LINK" });
    }
    diagnostics.overLimitDropped = Math.max(0, posts.length - maxPosts);
    const limited = posts.slice(0, maxPosts);
    return { status: limited.length ? "OK" : "NO_POSTS", posts: limited, diagnostics };
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

  scope.FlipGeckoPocAdapter = { classify, evaluate, inspectDomLinks, groupIdentity, MAX_POSTS_LIMIT };
})(globalThis);
