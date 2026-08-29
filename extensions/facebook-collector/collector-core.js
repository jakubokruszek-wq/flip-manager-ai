(function installCollectorCore(scope) {
  "use strict";

  const POST_PATHS = [
    /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/i,
    /\/(?:posts|videos)\/(\d+)/i,
    /\/story\.php/i,
  ];
  const ID_KEYS = new Set(["post_id", "postId", "story_fbid", "story_id", "storyId"]);
  const MEDIA_ID_KEYS = new Set(["media_id", "mediaId", "photo_id", "photoId", "video_id", "videoId"]);
  const PERMALINK_KEYS = new Set(["permalink", "permalink_url", "url"]);
  const TIME_KEYS = new Set(["creation_time", "publish_time", "timestamp", "created_time"]);
  const TEXT_KEYS = new Set(["message", "text", "body"]);

  function canonicalSource(urlValue) {
    const url = safeUrl(urlValue);
    if (!url || url.hostname !== "www.facebook.com") return null;
    const group = url.pathname.match(/^\/groups\/([^/?#]+)/i);
    if (group) return { sourceType: "GROUP", sourceId: group[1], sourceUrl: `https://www.facebook.com/groups/${group[1]}/` };
    const profileId = url.searchParams.get("id") || url.pathname.match(/^\/([^/?#]+)/i)?.[1];
    if (!profileId || ["groups", "login", "checkpoint"].includes(profileId.toLowerCase())) return null;
    return { sourceType: "PROFILE", sourceId: profileId, sourceUrl: `https://www.facebook.com/${profileId}/` };
  }

  function parsePostLink(value, source) {
    const url = safeUrl(value);
    if (!url || url.hostname !== "www.facebook.com") return null;
    let postId = url.searchParams.get("story_fbid") || url.searchParams.get("fbid");
    let sourceId = url.searchParams.get("id") || source?.sourceId || null;
    for (const pattern of POST_PATHS) {
      const match = url.pathname.match(pattern);
      if (!match) continue;
      if (pattern === POST_PATHS[0]) { sourceId = match[1]; postId = match[2]; }
      else if (match[1]) postId = match[1];
      break;
    }
    if (!postId || !/^\d{5,30}$/.test(postId)) return null;
    const sourceType = source?.sourceType || (url.pathname.startsWith("/groups/") ? "GROUP" : "PROFILE");
    const resolvedSourceId = sourceId || source?.sourceId;
    if (!resolvedSourceId) return null;
    if (source && (resolvedSourceId !== source.sourceId || sourceType !== source.sourceType)) return null;
    const permalink = sourceType === "GROUP"
      ? `https://www.facebook.com/groups/${resolvedSourceId}/posts/${postId}/`
      : `https://www.facebook.com/${resolvedSourceId}/posts/${postId}/`;
    return { postId, permalink, sourceId: resolvedSourceId, sourceType };
  }

  function mergeRecords(records, limit = 100) {
    const merged = new Map();
    for (const raw of records || []) {
      if (!raw?.postId || !raw?.permalink || !raw?.sourceId) continue;
      const current = merged.get(raw.postId);
      const next = current ? {
        ...current,
        author: current.author || raw.author || null,
        text: longest(current.text, raw.text),
        publishedAt: current.publishedAt || raw.publishedAt || null,
        timestampText: current.timestampText || raw.timestampText || null,
        discoveryLayers: unique([...(current.discoveryLayers || []), ...(raw.discoveryLayers || [])]),
        firstSeenIteration: Math.min(current.firstSeenIteration ?? 999, raw.firstSeenIteration ?? 999),
        media: mergeMedia([...(current.media || []), ...(raw.media || [])], raw.postId),
      } : { ...raw, discoveryLayers: unique(raw.discoveryLayers || []), media: mergeMedia(raw.media || [], raw.postId) };
      merged.set(raw.postId, next);
      if (merged.size >= limit) break;
    }
    return [...merged.values()];
  }

  function extractStructuredRecordsFromText(text, layer, source, iteration = 0) {
    if (!text || !source) return [];
    const roots = parseJsonBodies(String(text).slice(0, 4_000_000));
    const records = [];
    for (const root of roots) walk(root, (node) => {
      const postId = exactPostId(node);
      if (!postId) return;
      const link = findPermalink(node, postId, source);
      if (!link || link.postId !== postId) return;
      records.push({
        postId,
        permalink: link.permalink,
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        author: findAuthor(node),
        text: findText(node),
        publishedAt: findTimestamp(node),
        timestampText: null,
        media: findMedia(node, postId, layer),
        discoveryLayers: [layer],
        firstSeenIteration: iteration,
      });
    });
    return mergeRecords(records);
  }

  function evaluateHealth(input) {
    const visible = finite(input.visibleCardCount);
    const captured = finite(input.capturedPostCount);
    const ratio = visible ? Math.min(1, captured / visible) : captured ? 1 : 0;
    const reasons = [];
    if (input.failed) reasons.push("COLLECTOR_SOURCE_FAILED");
    if (!input.failed && visible === 0 && captured === 0) reasons.push("COLLECTOR_NO_VISIBLE_OR_CAPTURED_POSTS");
    if (visible >= 3 && captured < 3) reasons.push("COLLECTOR_LOW_CAPTURE_COUNT");
    if (visible >= 4 && ratio < 0.6) reasons.push("COLLECTOR_LOW_CAPTURE_RATIO");
    if (input.feedGrew && !input.newIdsAfterScroll) reasons.push("COLLECTOR_GROWING_FEED_WITHOUT_NEW_IDS");
    return { status: input.failed ? "FAILED" : reasons.length ? "DEGRADED" : "HEALTHY", visibleCardCount: visible, capturedPostCount: captured, captureRatio: ratio, scrolls: finite(input.scrolls), durationMs: finite(input.durationMs), stopReason: String(input.stopReason || "UNKNOWN").slice(0, 120), reasons };
  }

  function shouldStopDiscovery(input) {
    if (input.durationMs >= input.budgetMs) return "SOURCE_TIME_BUDGET";
    if (input.uniqueCount >= input.maxPosts) return "MAX_POSTS";
    if (input.reliableAgeCutoff) return "AGE_CUTOFF";
    if (input.scrolls >= input.maxScrolls) return "MAX_SCROLLS";
    if (input.scrolls >= input.minScrolls && input.consecutiveNoNew >= 3) return "NO_NEW_POSTS_3_SCROLLS";
    return null;
  }

  function needsSearchFallback(health, sourceType) {
    return sourceType === "GROUP" && health?.status === "DEGRADED";
  }

  function exactPostId(node) {
    if (!isObject(node)) return null;
    for (const key of ID_KEYS) {
      const value = scalarId(node[key]);
      if (value) return value;
    }
    const type = String(node.__typename || node.typename || "").toLowerCase();
    return /(?:story|post)/.test(type) ? scalarId(node.id) : null;
  }

  function findPermalink(node, postId, source) {
    let answer = null;
    walk(node, (child) => {
      if (answer || !isObject(child)) return;
      for (const key of PERMALINK_KEYS) {
        if (typeof child[key] !== "string") continue;
        const parsed = parsePostLink(child[key], source);
        if (parsed?.postId === postId) { answer = parsed; return; }
      }
    }, 6);
    return answer;
  }

  function findText(node) {
    const candidates = [];
    walkPath(node, (child, path) => {
      if (!isObject(child)) return;
      if (/(?:comment|feedback|actor|author|profile)/i.test(path.join("."))) return false;
      for (const key of TEXT_KEYS) {
        const value = child[key];
        const text = typeof value === "string" ? value : isObject(value) && typeof value.text === "string" ? value.text : null;
        if (text && text.length <= 20_000) candidates.push({ text, depth: path.length });
      }
    }, 5);
    candidates.sort((a, b) => a.depth - b.depth || b.text.length - a.text.length);
    return clean(candidates[0]?.text || null);
  }

  function findAuthor(node) {
    const actor = node.actors?.[0] || node.actor || node.author || node.owner;
    return clean(actor?.name || actor?.short_name || null)?.slice(0, 200) || null;
  }

  function findTimestamp(node) {
    let timestamp = null;
    walk(node, (child) => {
      if (timestamp || !isObject(child)) return;
      for (const key of TIME_KEYS) {
        const value = Number(child[key]);
        if (Number.isFinite(value) && value > 1_000_000_000) timestamp = new Date(value * (value > 10_000_000_000 ? 1 : 1000)).toISOString();
      }
    }, 4);
    return timestamp;
  }

  function findMedia(node, postId, layer) {
    const media = [];
    walkPath(node, (child, path) => {
      if (Array.isArray(child)) return true;
      if (!isObject(child) || (child !== node && exactPostId(child) && exactPostId(child) !== postId)) return false;
      const location = path.join(".");
      if (/(?:actor|author|profile|avatar|comment|feedback)/i.test(location)) return false;
      if (!/(?:attachment|media|photo|video)/i.test(location)) return true;
      const mediaId = firstKey(child, MEDIA_ID_KEYS);
      const url = mediaUrl(child);
      if (url && (mediaId || /(?:photo|image|media|attachments?)/i.test(String(child.__typename || child.typename || "")))) media.push({ url, mediaId, exactPostId: postId, exactAssociation: true, discoveryLayers: [layer] });
    }, 7);
    return mergeMedia(media, postId);
  }

  function mediaUrl(node) {
    for (const key of ["image", "photo_image", "thumbnail", "uri", "url", "src"]) {
      const value = node[key];
      const candidate = typeof value === "string" ? value : isObject(value) ? value.uri || value.url || value.src : null;
      const url = safeUrl(candidate);
      if (url?.protocol === "https:" && /(?:fbcdn\.net|facebook\.com)/i.test(url.hostname)) return url.toString();
    }
    return null;
  }

  function mergeMedia(items, postId) {
    const output = new Map();
    for (const item of items || []) {
      if (!item?.url) continue;
      const exact = item.exactAssociation === true && item.exactPostId === postId;
      const key = item.mediaId || item.url;
      const previous = output.get(key);
      output.set(key, { ...item, exactAssociation: exact, exactPostId: exact ? postId : null, discoveryLayers: unique([...(previous?.discoveryLayers || []), ...(item.discoveryLayers || [])]) });
    }
    return [...output.values()];
  }

  function parseJsonBodies(text) {
    const cleanText = text.replace(/^for\s*\(;;\);\s*/, "").trim();
    const roots = [];
    for (const candidate of [cleanText, ...cleanText.split(/\r?\n/).filter((line) => /^[\[{]/.test(line.trim()))]) {
      try { roots.push(JSON.parse(candidate)); } catch { /* diagnostic parser is fail-safe */ }
    }
    return roots;
  }

  function walk(value, visitor, maxDepth = 8, depth = 0, seen = new Set()) {
    if (depth > maxDepth || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const descend = visitor(value);
    if (descend === false) return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, visitor, maxDepth, depth + 1, seen);
  }
  function walkPath(value, visitor, maxDepth = 8, depth = 0, path = [], seen = new Set()) {
    if (depth > maxDepth || value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const descend = visitor(value, path);
    if (descend === false) return;
    if (Array.isArray(value)) value.forEach((child, index) => walkPath(child, visitor, maxDepth, depth + 1, [...path, String(index)], seen));
    else Object.entries(value).forEach(([key, child]) => walkPath(child, visitor, maxDepth, depth + 1, [...path, key], seen));
  }
  function firstKey(node, keys) { for (const key of keys) { const id = scalarId(node[key]); if (id) return id; } return null; }
  function scalarId(value) { const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : ""; return /^\d{5,30}$/.test(text) ? text : null; }
  function safeUrl(value) { try { return new URL(value, "https://www.facebook.com/"); } catch { return null; } }
  function longest(a, b) { return !a ? b || null : !b ? a : b.length > a.length ? b : a; }
  function clean(value) { return typeof value === "string" ? value.replace(/\s+/g, " ").trim() || null : null; }
  function unique(values) { return [...new Set(values)]; }
  function finite(value) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
  function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

  scope.FlipFacebookCollectorCore = { canonicalSource, parsePostLink, mergeRecords, extractStructuredRecordsFromText, evaluateHealth, shouldStopDiscovery, needsSearchFallback };
})(globalThis);
