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
    if (!input || !isGroupId(input.groupId) || path.replace(/\/+$/, "") !== `/groups/${input.groupId}`) return "WRONG_GROUP";
    return "GROUP_OK";
  }

  function evaluate(snapshot, input, core) {
    if (!core) throw Error("COLLECTOR_CORE_MISSING");
    const maxPosts = Math.max(1, Math.min(MAX_POSTS_LIMIT, Math.floor(Number(input && input.maxPosts) || MAX_POSTS_LIMIT)));
    const diagnostics = { visibleCards: 0, structuredScripts: 0, structuredRecords: 0, cardsWithoutId: 0, ambiguousCards: 0, foreignCards: 0, duplicatesDropped: 0, overLimitDropped: 0 };
    const state = classify(snapshot, input);
    if (state !== "GROUP_OK") return { status: state, posts: [], diagnostics };

    const groupId = input.groupId;
    const source = { sourceType: "GROUP", sourceId: groupId, sourceUrl: `https://www.facebook.com/groups/${groupId}/`, allowGroupRedirect: false };
    const records = [];

    // Structured (hydration) payloads: identity comes only from the core.
    for (const text of (snapshot.structured || []).slice(0, 100)) {
      if (typeof text !== "string" || text.length > 2_000_000) continue;
      diagnostics.structuredScripts++;
      const found = core.extractStructuredRecordsFromText(text, "HYDRATION", source, 0) || [];
      diagnostics.structuredRecords += found.length;
      for (const record of found) records.push({ postId: record.postId, permalink: record.permalink, sourceId: record.sourceId, sourceType: record.sourceType, idSource: "STRUCTURED" });
    }

    // Top-level cards: a card counts only with exactly one post id among its
    // own links (comments and nested cards are excluded by the snapshot).
    const cards = (snapshot.cards || []).slice(0, 300);
    diagnostics.visibleCards = cards.length;
    for (const card of cards) {
      const links = (card.hrefs || []).map(href => core.parsePostLink(href, source)).filter(Boolean);
      const foreign = (card.hrefs || []).map(href => core.parsePostLink(href)).filter(link => link && link.sourceId !== groupId);
      const ids = [...new Set(links.map(link => link.postId))];
      if (ids.length === 1) {
        records.push({ postId: links[0].postId, permalink: links[0].permalink, sourceId: links[0].sourceId, sourceType: links[0].sourceType, idSource: "DOM_LINK" });
      } else if (ids.length > 1) diagnostics.ambiguousCards++;
      else if (foreign.length) diagnostics.foreignCards++;
      else diagnostics.cardsWithoutId++;
    }

    const merged = core.mergeRecords(records, 10_000);
    diagnostics.duplicatesDropped = records.length - merged.length;
    const posts = [];
    for (const post of merged) {
      // Re-check the canonical link: only exact ids of this group survive.
      const link = core.parsePostLink(post.permalink, source);
      if (!link || link.postId !== post.postId || link.sourceId !== groupId || !/^\d{5,30}$/.test(post.postId)) continue;
      const layers = records.filter(record => record.postId === post.postId).map(record => record.idSource);
      posts.push({ postId: post.postId, permalink: link.permalink, idSource: layers.includes("STRUCTURED") ? "STRUCTURED" : "DOM_LINK" });
    }
    diagnostics.overLimitDropped = Math.max(0, posts.length - maxPosts);
    const limited = posts.slice(0, maxPosts);
    return { status: limited.length ? "OK" : "NO_POSTS", posts: limited, diagnostics };
  }

  function isGroupId(value) { return typeof value === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(value); }
  function safeUrl(value) { try { return new URL(value); } catch { return null; } }

  scope.FlipGeckoPocAdapter = { classify, evaluate, MAX_POSTS_LIMIT };
})(globalThis);
