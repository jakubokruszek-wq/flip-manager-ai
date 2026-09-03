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
    // A photo URL's `fbid` identifies media, not the enclosing post. Treating
    // it as a post id creates an invented canonical identity. Only accept
    // `fbid` on non-photo routes; photo results require an exact post permalink
    // or structured story id bound to the same card.
    const isPhotoRoute = /^\/photo(?:\.php)?(?:\/|$)/i.test(url.pathname);
    let postId = url.searchParams.get("story_fbid") || (!isPhotoRoute ? url.searchParams.get("fbid") : null);
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
      const conflict = current ? identityConflict(current, raw) : false;
      const next = current ? {
        ...current,
        author: conflict ? null : current.author || raw.author || null,
        text: conflict ? null : longest(current.text, raw.text),
        publishedAt: current.publishedAt || raw.publishedAt || null,
        timestampText: current.timestampText || raw.timestampText || null,
        discoveryLayers: unique([...(current.discoveryLayers || []), ...(raw.discoveryLayers || [])]),
        firstSeenIteration: Math.min(current.firstSeenIteration ?? 999, raw.firstSeenIteration ?? 999),
        media: mergeMedia([...(current.media || []), ...(raw.media || [])], raw.postId),
        discoverySource: current.discoverySource === "MAIN_FEED" || raw.discoverySource === "MAIN_FEED" ? "MAIN_FEED" : "SEARCH",
        searchQuery: current.searchQuery || raw.searchQuery || null,
        searchQueries: unique([...(current.searchQueries || []), ...(raw.searchQueries || []), ...(raw.searchQuery ? [raw.searchQuery] : [])]),
        foundInMainFeed: current.foundInMainFeed === true || raw.foundInMainFeed === true,
        firstSeenPhase: current.firstSeenPhase === "MAIN_FEED" || raw.firstSeenPhase === "MAIN_FEED" ? "MAIN_FEED" : "SEARCH",
        resolvedFromMediaTile: current.resolvedFromMediaTile === true || raw.resolvedFromMediaTile === true,
        mediaIds: unique([...(current.mediaIds || []), ...(raw.mediaIds || [])]),
        parentResolutionEvidence: unique([...(current.parentResolutionEvidence || []), ...(raw.parentResolutionEvidence || [])]),
        rootPostId: current.rootPostId || raw.rootPostId || null,
        rootAuthorSource: current.rootAuthorSource || raw.rootAuthorSource || null,
        rootTextSource: current.rootTextSource || raw.rootTextSource || null,
        rootTextVerified: current.rootTextVerified === true || raw.rootTextVerified === true,
        identityConfidence: conflict || (current.identityConfidence !== "EXACT" && raw.identityConfidence !== "EXACT") ? "UNVERIFIED" : "EXACT",
        identityReasons: unique([...(current.identityReasons || []), ...(raw.identityReasons || []), ...(conflict ? ["POST_IDENTITY_CONFLICT"] : [])]),
      } : { ...raw, discoverySource: raw.discoverySource === "SEARCH" ? "SEARCH" : "MAIN_FEED", searchQuery: raw.searchQuery || null, searchQueries: unique([...(raw.searchQueries || []), ...(raw.searchQuery ? [raw.searchQuery] : [])]), foundInMainFeed: raw.foundInMainFeed === true || raw.discoverySource !== "SEARCH", firstSeenPhase: raw.firstSeenPhase === "SEARCH" ? "SEARCH" : "MAIN_FEED", resolvedFromMediaTile: raw.resolvedFromMediaTile === true, mediaIds: unique(raw.mediaIds || []), parentResolutionEvidence: unique(raw.parentResolutionEvidence || []), identityConfidence: raw.identityConfidence === "EXACT" ? "EXACT" : "UNVERIFIED", identityReasons: unique(raw.identityReasons || []), discoveryLayers: unique(raw.discoveryLayers || []), media: mergeMedia(raw.media || [], raw.postId) };
      merged.set(raw.postId, next);
      if (merged.size >= limit) break;
    }
    return [...merged.values()];
  }

  // Root-story identity is deliberately explicit. Callers must provide values
  // extracted from the same card/story boundary; this helper never searches
  // neighbouring nodes or promotes a media/caption id.
  function resolveRootStoryIdentity(input, expectedPostId) {
    const postId = scalarId(expectedPostId);
    if (!postId || !isObject(input) || scalarId(input.rootPostId) !== postId) {
      return { identityConfidence: "UNVERIFIED", identityReasons: ["ROOT_STORY_POST_ID_MISMATCH"] };
    }
    const author = clean(input.author);
    const text = clean(input.text);
    const authorSource = clean(input.rootAuthorSource);
    const textSource = clean(input.rootTextSource);
    if (!author || !text || !authorSource || !textSource || input.rootTextVerified !== true) {
      return { identityConfidence: "UNVERIFIED", identityReasons: ["ROOT_STORY_AUTHOR_OR_TEXT_NOT_EXACT"] };
    }
    return {
      author: author.slice(0, 200),
      text: text.slice(0, 20_000),
      rootPostId: postId,
      rootAuthorSource: authorSource.slice(0, 120),
      rootTextSource: textSource.slice(0, 120),
      rootTextVerified: true,
      identityConfidence: "EXACT",
      identityReasons: ["ROOT_POST_ID", `ROOT_AUTHOR_SOURCE:${authorSource}`, `ROOT_TEXT_SOURCE:${textSource}`, "ROOT_TEXT_VERIFIED"],
    };
  }

  function extractStructuredRecordsFromText(text, layer, source, iteration = 0) {
    if (!text || !source) return [];
    const roots = parseJsonBodies(String(text).slice(0, 4_000_000));
    const records = [];
    for (const root of roots) walk(root, (node) => {
      const postId = exactStoryRootPostId(node);
      if (!postId) return;
      const link = findPermalink(node, postId, source);
      if (!link || link.postId !== postId) return;
      const author = findAuthor(node);
      const message = findRootMessage(node);
      records.push({
        postId,
        permalink: link.permalink,
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        author,
        text: message,
        publishedAt: findTimestamp(node),
        timestampText: null,
        media: findMedia(node, postId, layer),
        discoveryLayers: [layer],
        firstSeenIteration: iteration,
        identityConfidence: message && author ? "EXACT" : "UNVERIFIED",
        identityReasons: message && author ? ["STRUCTURED_EXACT_STORY_ROOT"] : ["STRUCTURED_STORY_WITHOUT_ROOT_AUTHOR_OR_TEXT"],
        __structuredDiagnostics: { structuredAuthorPresent: Boolean(author), structuredTextPresent: Boolean(message), structuredTextPath: findRootMessagePath(node) },
      });
    });
    return mergeRecords(records);
  }

  // Diagnostic-only inspection. It reports evidence already bound to the
  // requested media id; it never creates or promotes a canonical record.
  function inspectSearchMediaParentFromText(text, source, expectedMediaId) {
    const mediaId = scalarId(expectedMediaId);
    const result = {
      structuredPayloadFound: false,
      currMediaId: null,
      containerStoryPostId: null,
      topLevelPostId: null,
      mediaAttachmentCrosscheck: false,
      parentPostId: null,
      parentPermalink: null,
      rootAuthorFound: false,
      rootTextFound: false,
      identityResult: "UNVERIFIED",
      failSubstep: "SEARCH_PAYLOAD_NOT_FOUND",
    };
    if (!text || !source || !mediaId) return result;
    const roots = parseJsonBodies(String(text).slice(0, 4_000_000));
    result.structuredPayloadFound = roots.length > 0;
    for (const root of roots) walk(root, (node) => {
      if (!isObject(node)) return;
      if (scalarId(node.id) === mediaId && String(node.__typename || node.typename || "").toLowerCase() === "photo") {
        result.currMediaId = mediaId;
        const story = node.container_story;
        if (!isObject(story)) { result.failSubstep = "SEARCH_CONTAINER_STORY_MISSING"; return; }
        const postId = exactStoryRootPostId(story);
        if (!postId) { result.failSubstep = "SEARCH_PARENT_POST_ID_MISSING"; return; }
        result.containerStoryPostId = postId;
        const link = findPermalink(story, postId, source);
        if (link) { result.parentPostId = postId; result.parentPermalink = link.permalink; }
        result.rootAuthorFound = Boolean(findAuthor(story));
        result.rootTextFound = Boolean(findRootMessage(story));
        result.mediaAttachmentCrosscheck = Boolean(mediaUrl(node));
        result.identityResult = result.parentPermalink && result.rootAuthorFound && result.rootTextFound && result.mediaAttachmentCrosscheck ? "EXACT" : "UNVERIFIED";
        result.failSubstep = result.identityResult === "EXACT" ? null : !result.parentPermalink ? "SEARCH_PARENT_PERMALINK_MISSING" : !result.rootAuthorFound || !result.rootTextFound ? "SEARCH_ROOT_TEXT_MISSING" : "SEARCH_MEDIA_CROSSCHECK_FAILED";
      }
      if (result.currMediaId || !isObject(node)) return;
      const postId = exactStoryRootPostId(node);
      if (postId && hasExactMediaTracking(node, postId, mediaId)) {
        result.topLevelPostId = postId;
        result.mediaAttachmentCrosscheck = true;
        result.parentPostId = postId;
        const link = findPermalink(node, postId, source);
        result.parentPermalink = link?.permalink || null;
        result.rootAuthorFound = Boolean(findAuthor(node));
        result.rootTextFound = Boolean(findRootMessage(node));
        result.identityResult = result.parentPermalink && result.rootAuthorFound && result.rootTextFound ? "EXACT" : "UNVERIFIED";
        result.failSubstep = result.identityResult === "EXACT" ? null : !result.parentPermalink ? "SEARCH_PARENT_PERMALINK_MISSING" : "SEARCH_ROOT_TEXT_MISSING";
      }
    }, 16);
    if (!result.structuredPayloadFound) result.failSubstep = "SEARCH_PAYLOAD_NOT_FOUND";
    else if (!result.currMediaId && !result.topLevelPostId) result.failSubstep = "SEARCH_MEDIA_ID_NOT_FOUND";
    return result;
  }

  function hasExactMediaTracking(story, postId, mediaId) {
    let exact = false;
    walk(story, (node) => {
      if (exact || !isObject(node) || typeof node.tracking !== "string" || !node.tracking.includes(mediaId)) return;
      try {
        const tracking = JSON.parse(node.tracking);
        exact = scalarId(tracking.top_level_post_id) === postId
          && Array.isArray(tracking.photo_attachments_list)
          && tracking.photo_attachments_list.some((id) => scalarId(id) === mediaId);
      } catch { /* fail closed on non-JSON tracking */ }
    }, 7);
    return exact;
  }

  function resolveSearchMediaParentFromText(text, layer, source, expectedMediaId, iteration = 0) {
    const mediaId = scalarId(expectedMediaId);
    if (!text || !source || !mediaId) return [];
    const roots = parseJsonBodies(String(text).slice(0, 4_000_000));
    const records = [];
    for (const root of roots) walk(root, (node) => {
      if (!isObject(node) || scalarId(node.id) !== mediaId || String(node.__typename || node.typename || "").toLowerCase() !== "photo") return;
      const story = node.container_story;
      if (!isObject(story)) return;
      const postId = exactStoryRootPostId(story);
      if (!postId) return;
      const link = findPermalink(story, postId, source);
      if (!link || link.postId !== postId) return;
      const author = findAuthor(story);
      const message = findRootMessage(story);
      const url = mediaUrl(node);
      const exactIdentity = Boolean(author && message && url);
      records.push({
        postId,
        permalink: link.permalink,
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        author,
        text: message,
        publishedAt: findTimestamp(story),
        timestampText: null,
        media: url ? [{ url, mediaId, exactPostId: exactIdentity ? postId : null, exactAssociation: exactIdentity, discoveryLayers: [layer] }] : [],
        discoveryLayers: [layer],
        firstSeenIteration: iteration,
        identityConfidence: exactIdentity ? "EXACT" : "UNVERIFIED",
        identityReasons: exactIdentity ? ["STRUCTURED_EXACT_MEDIA_CONTAINER_STORY"] : ["MEDIA_CONTAINER_STORY_WITHOUT_AUTHOR_TEXT_OR_URL"],
      });
    }, 16);
    for (const root of roots) walk(root, (story) => {
      const postId = exactStoryRootPostId(story);
      if (!postId || !hasExactMediaTracking(story, postId, mediaId)) return;
      const link = findPermalink(story, postId, source);
      if (!link || link.postId !== postId) return;
      const author = findAuthor(story);
      const message = findRootMessage(story);
      const exactIdentity = Boolean(author && message);
      records.push({
        postId,
        permalink: link.permalink,
        sourceId: source.sourceId,
        sourceType: source.sourceType,
        author,
        text: message,
        publishedAt: findTimestamp(story),
        timestampText: null,
        media: [],
        discoveryLayers: [layer],
        firstSeenIteration: iteration,
        identityConfidence: exactIdentity ? "EXACT" : "UNVERIFIED",
        identityReasons: exactIdentity ? ["STRUCTURED_EXACT_MEDIA_TRACKING_TO_STORY"] : ["MEDIA_TRACKING_STORY_WITHOUT_AUTHOR_OR_TEXT"],
      });
    }, 16);
    return mergeRecords(records);
  }

  function verifySearchMediaParent(records, expectedMediaId) {
    const mediaId = scalarId(expectedMediaId);
    if (!mediaId) return { status: "UNVERIFIED", records: [], reasons: ["SEARCH_MEDIA_RESOLVE_INPUT_INVALID"] };
    const exact = mergeRecords(records).filter((record) => record.identityConfidence === "EXACT" && (record.media || []).some((media) => media.mediaId === mediaId && media.exactAssociation === true && media.exactPostId === record.postId));
    if (exact.length !== 1) return { status: "UNVERIFIED", records: [], reasons: [exact.length ? "SEARCH_MEDIA_MULTIPLE_PARENT_POSTS" : "SEARCH_MEDIA_EXACT_PARENT_NOT_PROVEN"] };
    const record = exact[0];
    return { status: "VERIFIED", records: [{ ...record, media: [], resolvedFromMediaTile: true, mediaIds: [mediaId], parentResolutionEvidence: record.identityReasons || [] }], reasons: ["SEARCH_MEDIA_EXACT_PARENT_PROVEN"] };
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
    if (input.visibleFeedAdvanced && !input.capturedAdvanced) reasons.push("COLLECTOR_VISIBLE_FEED_ADVANCED_WITHOUT_CAPTURE_GROWTH");
    return { status: input.failed ? "FAILED" : reasons.length ? "DEGRADED" : "HEALTHY", visibleCardCount: visible, capturedPostCount: captured, captureRatio: ratio, scrolls: finite(input.scrolls), durationMs: finite(input.durationMs), stopReason: String(input.stopReason || "UNKNOWN").slice(0, 120), reasons };
  }

  function shouldStopDiscovery(input) {
    if (input.durationMs >= input.budgetMs) return "SOURCE_TIME_BUDGET";
    if (input.uniqueCount >= input.maxPosts) return "MAX_POSTS";
    if (input.scrolls >= input.minScrolls && input.consecutiveOldNewPosts >= 5) return "RELIABLE_AGE_CUTOFF";
    if (input.scrolls >= input.maxScrolls) return "MAX_SCROLLS";
    if (input.scrolls >= input.minScrolls && input.consecutiveNoNew >= 3 && input.consecutiveNoVisibleGrowth >= 3) return "NO_NEW_POSTS_AND_CARDS_3_SCROLLS";
    return null;
  }

  function updateAgeCutoffStreak(previous, newRecords, now = Date.now(), cutoffMs = 72 * 60 * 60 * 1000) {
    let streak = Math.max(0, Number(previous) || 0);
    for (const record of newRecords || []) {
      const timestamp = typeof record?.publishedAt === "string" ? Date.parse(record.publishedAt) : Number.NaN;
      if (!Number.isFinite(timestamp)) { streak = 0; continue; }
      streak = now - timestamp > cutoffMs ? streak + 1 : 0;
    }
    return streak;
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

  function exactStoryRootPostId(node) {
    if (!isObject(node)) return null;
    const direct = scalarId(node.post_id) || scalarId(node.postId) || scalarId(node.story_fbid) || scalarId(node.story_id) || scalarId(node.storyId);
    const type = String(node.__typename || node.typename || "").toLowerCase();
    if (direct && (!type || /(?:story|post)/.test(type))) return direct;
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

  function findRootMessage(node) {
    for (const key of ["message", "text", "body"]) {
      const value = node[key];
      const text = typeof value === "string" ? value : isObject(value) && typeof value.text === "string" ? value.text : null;
      const cleaned = clean(text);
      if (cleaned && cleaned.length <= 20_000) return cleaned;
    }
    return null;
  }

  function findRootMessagePath(node) {
    for (const key of ["message", "text", "body"]) {
      const value = node?.[key];
      const text = typeof value === "string" ? value : isObject(value) && typeof value.text === "string" ? value.text : null;
      if (clean(text)) return key;
    }
    let pathFound = null;
    walkPath(node, (child, path) => {
      if (pathFound || !isObject(child)) return false;
      const location = path.join(".");
      if (/(?:comment|feedback|attachment|media|caption)/i.test(location)) return false;
      for (const key of ["message", "text", "body"]) {
        const value = child[key];
        const text = typeof value === "string" ? value : isObject(value) && typeof value.text === "string" ? value.text : null;
        if (clean(text)) { pathFound = [...path, key].join("."); return false; }
      }
      return true;
    }, 6);
    return pathFound;
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
  function identityConflict(a, b) {
    const authorA = comparable(a.author); const authorB = comparable(b.author);
    if (authorA && authorB && authorA !== authorB) return true;
    const textA = comparable(a.text); const textB = comparable(b.text);
    return Boolean(textA && textB && !textA.includes(textB) && !textB.includes(textA));
  }
  function comparable(value) { return clean(value)?.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL") || ""; }
  function finite(value) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0; }
  function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

  scope.FlipFacebookCollectorCore = { canonicalSource, parsePostLink, mergeRecords, resolveRootStoryIdentity, extractStructuredRecordsFromText, inspectSearchMediaParentFromText, resolveSearchMediaParentFromText, verifySearchMediaParent, evaluateHealth, shouldStopDiscovery, updateAgeCutoffStreak, needsSearchFallback };
})(globalThis);
