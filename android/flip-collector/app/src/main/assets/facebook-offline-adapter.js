(function installOfflineAdapter(scope) {
  "use strict";
  // No chrome.*, runtime messaging, fetch, XHR or navigation. Receives a local
  // WebView Document; identity/media algorithms are the unchanged extension core.
  function collect(document, input) {
    const core = scope.FlipFacebookCollectorCore;
    if (!core) throw Error("COLLECTOR_CORE_MISSING");
    const url = new URL(input.sourceUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !["www.facebook.com", "facebook.com", "m.facebook.com"].includes(url.hostname)) throw Error("SOURCE_INVALID");
    const expected = input.sourceType === "GROUP" ? `/groups/${input.sourceId}/` : "/profile.php";
    if (input.sourceType === "GROUP" ? url.pathname.replace(/\/$/, "") !== expected.replace(/\/$/, "")
      : input.sourceType !== "PROFILE" || url.pathname !== expected || url.searchParams.get("id") !== input.sourceId) throw Error("SOURCE_INVALID");
    const source = { ...input, allowGroupRedirect: false };
    const records = []; const diagnostics = { documents: 1, structuredScripts: 0, unverifiedCards: 0, rejectedImages: 0, conflictingPosts: 0 };
    for (const script of Array.from(document.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]')).slice(0, 100)) {
      const text = script.textContent || "";
      if (text.length > 2_000_000) throw Error("STRUCTURED_PAYLOAD_TOO_LARGE");
      diagnostics.structuredScripts++;
      records.push(...core.extractStructuredRecordsFromText(text, "HYDRATION", source, 0));
    }
    // DOM-only cards remain UNVERIFIED. Text/author on an arbitrary card cannot
    // establish the exact root story; DOM images are never attached speculatively.
    for (const card of Array.from(document.querySelectorAll('article,[role="article"]')).slice(0, 150)) {
      const links = Array.from(card.querySelectorAll('a[href]')).map(a => core.parsePostLink(a.href, source)).filter(Boolean);
      const unique = [...new Set(links.map(link => link.postId))];
      diagnostics.rejectedImages += card.querySelectorAll("img").length;
      if (unique.length !== 1) { diagnostics.unverifiedCards++; continue; }
      const link = links[0];
      if (link.sourceId !== input.sourceId || link.sourceType !== input.sourceType) continue;
      // Structured extraction is authoritative. DOM fallback must not poison an
      // exact record with surrounding buttons/comments or borrow another author.
      if (records.some(record => record.postId === link.postId)) continue;
      records.push({ ...link, text: String(card.innerText || card.textContent || "").slice(0, 20_000), author: null, publishedAt: null,
        identityConfidence: "UNVERIFIED", identityReasons: ["DOM_ROOT_NOT_CONFIRMED"], media: [], discoveryLayers: ["DOM"] });
      diagnostics.unverifiedCards++;
    }
    const posts = core.mergeRecords(records, 150).filter(post => {
      const link = core.parsePostLink(post.permalink, source);
      return link && link.postId === post.postId && link.sourceId === input.sourceId && link.sourceType === input.sourceType;
    }).map(post => {
      if (post.identityConfidence !== "EXACT") diagnostics.conflictingPosts++;
      const media = post.identityConfidence === "EXACT" ? post.media.filter(item => item.exactAssociation === true && item.exactPostId === post.postId && safeMedia(item.url)) : [];
      diagnostics.rejectedImages += post.media.length - media.length;
      return { ...post, media };
    });
    return { sourceId: input.sourceId, sourceType: input.sourceType, sourceUrl: input.sourceUrl, posts, diagnostics };
  }
  function safeMedia(value) {
    try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && (u.hostname.endsWith(".fbcdn.net") || u.hostname === "fbcdn.net"); } catch { return false; }
  }
  scope.FlipAndroidOfflineAdapter = { collect };
})(globalThis);
