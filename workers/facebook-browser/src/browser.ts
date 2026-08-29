import { chromium, errors as playwrightErrors } from "playwright";
import type { FacebookAgeCacheEntry, FacebookAgeCacheHit, FacebookGroupSnapshot, FacebookImageRevalidationCandidate, FacebookPerformanceMetrics, FacebookPostCacheHit, FacebookPostPerformanceTiming, FacebookPostSnapshot, FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { createCachedFacebookPostSnapshot, emptyFacebookPerformanceMetrics, partitionFacebookPostsByCache } from "../../../features/facebook-worker/performance.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { assertWorkerFacebookSourceUrl } from "./source-reader.ts";
import { logFacebookWorker } from "./logger.ts";
import { resolveFacebookListingIntent } from "../../../features/facebook-watcher/facebook-intent.ts";

export function shouldEarlyRejectFacebookFeed(text: string | null | undefined): boolean {
  if (!text?.trim()) return false;
  const decision = resolveFacebookListingIntent(text, null, null);
  return decision.visionIntent === "UNKNOWN"
    && ["BUY_PROPERTY", "RENT_OFFER", "RENT_WANTED", "SERVICE"].includes(decision.intent)
    && Boolean(decision.reasonCode);
}
import { applyFacebookTargetedFreshnessBypass, captureFacebookPostRegion, collectFacebookPostTimeDiagnostic, detectFacebookPostAgeOnDedicatedPage, discoverFacebookPosts, discoverFacebookPostsByScrolling, isExpectedFacebookPostPage, limitFacebookVisionPosts, MAX_FACEBOOK_DISCOVERED_POSTS, MAX_VISION_POSTS_PER_JOB, processDedicatedFacebookPost, resolveFacebookPostAge, resolveFacebookPostAgeFromCache, resolveFacebookPostDiscovery, type FreshDiscoveredFacebookPost } from "./post-page.ts";
import { classifyFacebookSession } from "./session.ts";
import { discoverFacebookStructuredFeedPosts } from "./structured-feed-discovery.ts";

export async function revalidateFacebookPostImages(
  profileDir: string,
  target: { postId: string; permalink: string },
  signal: AbortSignal,
  analyzeRegion: (input: { postId: string; screenshotDataUrl: string; imageUrls: string[] }, signal: AbortSignal) => Promise<FacebookVisionExtraction>,
): Promise<{ candidates: FacebookImageRevalidationCandidate[]; verifiedCandidates: FacebookImageRevalidationCandidate[]; pageOpens: number; visionCalls: number }> {
  const context = await chromium.launchPersistentContext(profileDir, { headless: true, locale: "pl-PL" });
  let pageOpens = 0;
  let visionCalls = 0;
  try {
    signal.throwIfAborted();
    const page = context.pages()[0] ?? await context.newPage();
    const opened = await openFacebookPostPage(page, target.permalink, "revalidation", target.postId);
    if (opened) pageOpens += 1;
    const region = await captureFacebookPostRegion(page, target.postId);
    signal.throwIfAborted();
    visionCalls += 1;
    const vision = await analyzeRegion({ postId: target.postId, screenshotDataUrl: region.screenshotDataUrl, imageUrls: region.imageUrls }, signal);
    const assessments = new Map(vision.imageAssessments.map((assessment) => [assessment.imageIndex, assessment]));
    const candidates = region.mediaCandidates.map((candidate) => {
      const index = region.imageUrls.indexOf(candidate.url);
      const assessment = assessments.get(index);
      return { ...candidate, classification: assessment?.relevance ?? "UNKNOWN", classificationConfidence: assessment?.confidence ?? null };
    });
    const verifiedCandidates = candidates.filter((candidate) => candidate.storyRootPostId === target.postId && candidate.boundPostId === target.postId && candidate.rootStoryUnique && candidate.foreignPostIdsDetected.length === 0 && candidate.bindingConfidence >= 0.9);
    return { candidates, verifiedCandidates, pageOpens, visionCalls };
  } finally {
    await context.close();
  }
}

export async function fetchFacebookGroupWithBrowser(profileDir: string, group: FacebookGroupSnapshot, signal: AbortSignal, analyzeRegion: (input: { postId: string; screenshotDataUrl: string; imageUrls: string[] }, signal: AbortSignal) => Promise<FacebookVisionExtraction>, heartbeat?: () => Promise<void>, timeDiagnosticMode = false, debugMaxPosts: number | null = null, mediaDiagnosticMode = false, debugPostId: string | null = null, lookupCache?: (postIds: string[], signal: AbortSignal) => Promise<{ hits: Record<string, FacebookPostCacheHit & { publishedAt: string }>; ageHits: Record<string, FacebookAgeCacheHit> }>) {
  const started = Date.now(); const url = assertWorkerFacebookSourceUrl(group.url, group.type ?? "GROUP").toString();
  const performance: FacebookPerformanceMetrics = emptyFacebookPerformanceMetrics();
  const postTimings = new Map<string, FacebookPostPerformanceTiming>();
  const timingFor = (postId: string): FacebookPostPerformanceTiming => { const existing = postTimings.get(postId); if (existing) return existing; const created: FacebookPostPerformanceTiming = { postId, feedDiscoveryMs: 0, ageDetectionMs: 0, ageFallbackMs: 0, dedicatedPageNavigationMs: 0, extractionMs: 0, visionMs: 0, persistenceMs: 0, completionMs: 0, totalMs: 0, cacheHit: false }; postTimings.set(postId, created); return created; };
  const finalizeTimings = () => { performance.postTimings = [...postTimings.values()].map((timing) => ({ ...timing, totalMs: timing.feedDiscoveryMs + timing.ageDetectionMs + timing.dedicatedPageNavigationMs + timing.extractionMs + timing.visionMs + timing.persistenceMs + timing.completionMs })); performance.totalNavigationMs = performance.postTimings.reduce((sum, item) => sum + item.dedicatedPageNavigationMs, 0); performance.totalVisionMs = performance.postTimings.reduce((sum, item) => sum + item.visionMs, 0); performance.totalAgeFallbackMs = performance.postTimings.reduce((sum, item) => sum + item.ageFallbackMs, 0); performance.cacheHitCount = performance.postTimings.filter((item) => item.cacheHit).length; performance.cacheMissCount = performance.postTimings.filter((item) => !item.cacheHit).length; };
  const ageCache: FacebookAgeCacheEntry[] = [];
  const cacheHits: Record<string, FacebookPostCacheHit & { publishedAt: string }> = {};
  const ageCacheHits: Record<string, FacebookAgeCacheHit> = {};
  const cacheLookedUp = new Set<string>();
  const lookupAndRemember = async (postIds: string[]) => {
    if (!lookupCache) return { hits: cacheHits, ageHits: ageCacheHits };
    const missing = postIds.filter((postId) => !cacheLookedUp.has(postId));
    missing.forEach((postId) => cacheLookedUp.add(postId));
    if (missing.length > 0) {
      const found = await lookupCache(missing, signal).catch((error) => { logFacebookWorker("FACEBOOK_POST_CACHE_ERROR", { message: error instanceof Error ? error.message.slice(0, 200) : "CACHE_LOOKUP_FAILED" }); return { hits: {}, ageHits: {} }; });
      Object.assign(cacheHits, found.hits); Object.assign(ageCacheHits, found.ageHits);
    }
    return { hits: cacheHits, ageHits: ageCacheHits };
  };
  const lookupKnown = !debugPostId && lookupCache ? async (postIds: string[]) => {
    const found = await lookupAndRemember(postIds);
    return Object.fromEntries(postIds.flatMap((postId) => found.ageHits[postId]?.decision === "TOO_OLD" ? [[postId, { publishedAt: found.ageHits[postId].publishedAt! }]] : []));
  } : undefined;
  logFacebookWorker("FACEBOOK_BROWSER_START", { groupId: group.id });
  const context = await chromium.launchPersistentContext(profileDir, { headless: true, locale: "pl-PL" });
  try {
    signal.throwIfAborted(); const page = context.pages()[0] ?? await context.newPage();
    if (!debugPostId) {
      logFacebookWorker("FACEBOOK_GROUP_START", { groupId: group.id });
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }); performance.pageOpens += 1;
      signal.throwIfAborted();
      await assertAccessibleFacebookPage(page);
      if (response && !response.ok()) throw new ControlledFacebookFailure(response.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook group returned HTTP ${response.status()}`);
      logFacebookWorker("FACEBOOK_SESSION_OK", { groupId: group.id });
      const feedReady = await waitForFacebookGroupFeed(page);
      logFacebookWorker("FACEBOOK_GROUP_FEED_READY", { groupId: group.id, postLinkFound: feedReady });
    } else {
      logFacebookWorker("FACEBOOK_DEBUG_TARGET_MODE", { groupId: group.id, postId: debugPostId });
    }
    const ageReferenceMs = Date.now();
    if (timeDiagnosticMode) {
      const firstPost = (await discoverFacebookPosts(page, 1, ageReferenceMs))[0];
      if (!firstPost) return { posts: [], warnings: ["FACEBOOK_POST_DISCOVERY_EMPTY"], durationMs: Date.now() - started, performance, ageCache };
      logFacebookWorker("FACEBOOK_POST_DISCOVERED", { groupId: group.id, postId: firstPost.postId, order: 0, freshnessFailure: firstPost.freshnessFailure });
      performance.pageOpens += await openFacebookPostPage(page, firstPost.permalink, group.id, firstPost.postId) ? 1 : 0;
      const timeDiagnostic = await collectFacebookPostTimeDiagnostic(page, firstPost.postId, ageReferenceMs);
      logFacebookWorker("FACEBOOK_POST_TIME_DIAGNOSTIC", timeDiagnostic);
      await heartbeat?.();
      return { posts: [], warnings: ["FACEBOOK_TIME_DIAGNOSTIC_COMPLETE"], durationMs: Date.now() - started, performance, ageCache };
    }
    const discoveryStarted = Date.now(); const discovery = await resolveFacebookPostDiscovery({ groupUrl: url, debugPostId, discover: async () => {
      // Facebook can hydrate post records several scrolls after anchors appear. Collect
      // structured records on every pass so an early anchor-only empty-stop cannot hide
      // fresh posts that are already present in the page's JSON payload.
      const collect = async () => {
        const [anchors, structured] = await Promise.all([
          discoverFacebookPosts(page, MAX_FACEBOOK_DISCOVERED_POSTS, ageReferenceMs),
          discoverFacebookStructuredFeedPosts(page, ageReferenceMs, MAX_FACEBOOK_DISCOVERED_POSTS),
        ]);
        const posts = new Map(anchors.map((post) => [post.postId, post]));
        for (const post of structured) {
          const existing = posts.get(post.postId);
          if (!existing || existing.freshnessFailure && !post.freshnessFailure) posts.set(post.postId, post);
        }
        return [...posts.values()].slice(0, MAX_FACEBOOK_DISCOVERED_POSTS);
      };
      const result = await discoverFacebookPostsByScrolling(page, ageReferenceMs, heartbeat, lookupKnown, collect);
      return result;
    } }); const discoveryDuration = Date.now() - discoveryStarted; const discovered = discovery.posts; const feedTexts = await page.evaluate(() => {
      const postIdFromHref = (href: string) => { try { return new URL(href, location.href).pathname.match(/(?:\/groups\/[^/]+|\/[^/]+)\/posts\/(\d+)/i)?.[1] ?? null; } catch { return null; } };
      const result: Record<string, string> = {};
      for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"]'))) {
        const postId = postIdFromHref(link.href); const article = link.closest<HTMLElement>('[role="article"]');
        if (!postId || !article) continue;
        const ids = new Set(Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"]')).map((anchor) => postIdFromHref(anchor.href)).filter((id): id is string => Boolean(id)));
        if (ids.size !== 1 || !ids.has(postId) || result[postId]) continue;
        const textParts: string[] = [];
        const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement; const value = node.textContent?.replace(/\s+/g, " ").trim();
          if (!parent || !value) continue;
          const nestedArticle = parent.closest('[role="article"]');
          if (nestedArticle && nestedArticle !== article) continue;
          const markerPath = Array.from({ length: 8 }, (_, depth) => { let element: Element | null = parent; for (let index = 0; index < depth && element; index += 1) element = element.parentElement; return element; }).filter((element): element is Element => Boolean(element)).map((element) => [element.getAttribute("role"), element.getAttribute("data-testid"), element.getAttribute("data-pagelet"), element.getAttribute("aria-label")].filter(Boolean).join(" ")).join(" ");
          if (/comment|reply|komentar|odpowied|shared|attachment|substory|reshar/i.test(markerPath)) continue;
          textParts.push(value);
        }
        const safeText = textParts.join(" ").replace(/\s+/g, " ").trim().slice(0, 4_000);
        if (safeText) result[postId] = safeText;
      }
      return result;
    }); for (const post of discovered) if (!feedTexts[post.postId] && post.discoveredText) feedTexts[post.postId] = post.discoveredText; discovered.forEach((post) => { timingFor(post.postId).feedDiscoveryMs = discoveryDuration; }); const posts: FacebookPostSnapshot[] = []; const warnings: string[] = []; const freshPosts: FreshDiscoveredFacebookPost[] = []; const processedFreshPostIds = new Set<string>(); let tooOldCount = 0; let unknownCount = 0; let debugSessionConfirmed = false;
    const visionCapacity = debugPostId ? 1 : debugMaxPosts ?? MAX_VISION_POSTS_PER_JOB;
    const processFreshPost = async (post: FreshDiscoveredFacebookPost) => {
      try {
        signal.throwIfAborted();
        const extractionStarted = Date.now();
        const snapshot = await processDedicatedFacebookPost(post, group.id, {
          open: async (permalink) => {
            const alreadyOpen = isExpectedFacebookPostPage(page.url(), post.postId);
            const navigationStarted = Date.now(); performance.pageOpens += await openFacebookPostPage(page, permalink, group.id, post.postId) ? 1 : 0; timingFor(post.postId).dedicatedPageNavigationMs += Date.now() - navigationStarted;
            if (alreadyOpen) performance.dedicatedPageReuses += 1;
          },
          capture: async (postId) => { const region = await captureFacebookPostRegion(page, postId); logFacebookWorker("FACEBOOK_POST_REGION_FOUND", { groupId: group.id, postId, candidateCount: region.candidateCount, width: Math.round(region.box.width), height: Math.round(region.box.height), imageCount: region.imageUrls.length }); return region; },
          analyze: async (input) => { const visionStarted = Date.now(); performance.visionCalls += 1; logFacebookWorker("FACEBOOK_POST_VISION_START", { groupId: group.id, postId: input.postId }); const vision = await analyzeRegion(input, signal); timingFor(input.postId).visionMs += Date.now() - visionStarted; logFacebookWorker("FACEBOOK_POST_VISION_DONE", { groupId: group.id, postId: input.postId, isProperty: vision.isProperty, confidence: vision.confidence, detectedFieldCount: [vision.price, vision.area, vision.rooms, vision.street, vision.neighborhood, vision.district].filter((value) => value !== null).length }); return vision; },
        });
        timingFor(post.postId).extractionMs += Date.now() - extractionStarted;
        posts.push(snapshot); processedFreshPostIds.add(post.postId);
      } catch (error) {
        if (error instanceof ControlledFacebookFailure) throw error;
        const reasonCode = controlledPostFailureCode(error);
        warnings.push(`${reasonCode}: post ${post.postId} nie zostaĹ‚ przetworzony.`);
        logFacebookWorker("FACEBOOK_POST_EXTRACTION_FAILED", { groupId: group.id, postId: post.postId, reasonCode });
        processedFreshPostIds.add(post.postId);
      }
    };
    performance.postsDiscovered = discovered.length; performance.discoveredPostIds = discovered.map((post) => post.postId); performance.discoveryScrolls = discovery.scrollCount;
    performance.feedAgeHits = discovered.filter((post) => post.discoveredPublishedAt !== null).length;
    const feedDiagnostics = discovered.flatMap((post) => post.feedAgeDiagnostic ? [post.feedAgeDiagnostic] : []);
    performance.feedTimestampCandidates = feedDiagnostics.reduce((total, diagnostic) => total + diagnostic.candidatesFound, 0);
    performance.exactBoundFeedTimestamps = performance.feedAgeHits;
    performance.rejectedAmbiguousFeedTimestamps = feedDiagnostics.filter((diagnostic) => diagnostic.rejectionReason === "AMBIGUOUS_TIMESTAMP" || diagnostic.rejectionReason === "DATE_PRECISION_CROSSES_72H").length;
    performance.feedAgeHitRate = discovered.length > 0 ? performance.feedAgeHits / discovered.length : 0;
    for (const diagnostic of feedDiagnostics) logFacebookWorker("FACEBOOK_FEED_AGE_DIAGNOSTIC", diagnostic);
    performance.earlyStopOldBoundaryCount = discovery.stopReason === "OLDER_THAN_72H" || discovery.stopReason === "KNOWN_OLD_SEQUENCE" ? 1 : 0;
    if (!debugPostId && lookupCache) await lookupAndRemember(discovered.map((post) => post.postId));
    const partitioned = partitionFacebookPostsByCache(discovered, cacheHits, ageReferenceMs);
    performance.fullExtractionCacheHits = partitioned.cached.length;
    performance.fullExtractionCacheMisses = partitioned.uncached.length;
    for (const { post, hit } of partitioned.cached) {
      timingFor(post.postId).cacheHit = true;
      posts.push(createCachedFacebookPostSnapshot(post, group, hit));
      performance.visionCacheHits += 1; performance.knownPostSkips += 1;
      if (hit.scope === "RUN") {
        performance.duplicatePostIdsSkipped += 1; performance.duplicatePostIdsAcrossGroups += 1;
        performance.duplicateVisionCallsAvoided += 1; performance.duplicatePageOpensAvoided += 1;
      }
    }
    for (const [order, post] of partitioned.uncached.entries()) {
      logFacebookWorker("FACEBOOK_POST_DISCOVERED", { groupId: group.id, postId: post.postId, order, freshnessFailure: post.freshnessFailure });
      const cachedAge = !debugPostId && !post.discoveredPublishedAt ? ageCacheHits[post.postId] : undefined;
      const feedText = feedTexts[post.postId] ?? null;
      const feedIntent = feedText ? resolveFacebookListingIntent(feedText, null, null) : null;
      const deterministicNonSell = shouldEarlyRejectFacebookFeed(feedText);
      if (!debugPostId && deterministicNonSell) {
        posts.push({ postId: post.postId, groupId: group.id, permalink: post.permalink, authoritativePostText: feedText ?? "", authoritativePostTextSource: "POST_REGION_DOM", authoritativePostTextProvenance: "ROOT_AUTHOR_MESSAGE", text: feedText ?? "", imageUrls: [], mediaCandidates: [], publishedAt: post.discoveredPublishedAt, vision: null });
        performance.knownPostSkips += 1;
        logFacebookWorker("FACEBOOK_FEED_INTENT_EARLY_SKIP", { groupId: group.id, postId: post.postId, intent: feedIntent!.intent, reasonCode: feedIntent!.reasonCode });
        continue;
      }
      let dedicatedPageOpenedForAge = false;
      const ageStarted = Date.now();
      const resolvedAge = cachedAge ? resolveFacebookPostAgeFromCache(post, cachedAge, ageReferenceMs) : await resolveFacebookPostAge(post, ageReferenceMs, async () => {
          const fallbackStarted = Date.now();
          performance.agePageFallbacks += 1;
          performance.pageOpens += await openFacebookPostPage(page, post.permalink, group.id, post.postId) ? 1 : 0;
          dedicatedPageOpenedForAge = true;
          if (debugPostId && !debugSessionConfirmed) { logFacebookWorker("FACEBOOK_SESSION_OK", { groupId: group.id }); debugSessionConfirmed = true; }
          const detectedAge = await detectFacebookPostAgeOnDedicatedPage(page, post.postId, ageReferenceMs);
          await heartbeat?.();
          timingFor(post.postId).ageFallbackMs += Date.now() - fallbackStarted; return detectedAge;
        });
      timingFor(post.postId).ageDetectionMs += Date.now() - ageStarted;
      const age = applyFacebookTargetedFreshnessBypass(resolvedAge, debugPostId);
      if (cachedAge) performance.ageCacheHits += 1;
      if (age.decision === "TOO_OLD" && (post.discoveredPublishedAt || cachedAge)) performance.oldPostsSkippedBeforePageOpen += 1;
      if (!debugPostId) ageCache.push({ postId: post.postId, checkedAt: cachedAge?.checkedAt ?? new Date(ageReferenceMs).toISOString(), publishedAt: resolvedAge.post.discoveredPublishedAt, decision: resolvedAge.decision === "PROCESS" ? "FRESH" : resolvedAge.decision, source: cachedAge?.source ?? (resolvedAge.source === "AGE_CACHE" ? "POST_PAGE" : resolvedAge.source) });
      logFacebookWorker("FACEBOOK_POST_AGE_DETECTED", { postId: post.postId, source: age.source, ageHours: age.ageHours === null ? null : Math.round(age.ageHours * 100) / 100, decision: age.decision });
      if (age.post.freshnessFailure) {
        if (age.post.freshnessFailure === "FACEBOOK_POST_TOO_OLD") tooOldCount += 1;
        else unknownCount += 1;
        warnings.push(`${age.post.freshnessFailure}: post ${post.postId} nie został przetworzony.`);
        logFacebookWorker("FACEBOOK_POST_EXTRACTION_FAILED", { groupId: group.id, postId: post.postId, reasonCode: age.post.freshnessFailure });
      } else {
        freshPosts.push(age.post);
        if (!mediaDiagnosticMode && dedicatedPageOpenedForAge && processedFreshPostIds.size < visionCapacity) await processFreshPost(age.post);
        if (debugPostId || mediaDiagnosticMode || debugMaxPosts !== null && freshPosts.length >= debugMaxPosts) break;
      }
    }
    logFacebookWorker("FACEBOOK_DISCOVERY_COMPLETE", { discoveredTotal: discovered.length, freshCount: freshPosts.length, tooOldCount, unknownCount, scrollCount: discovery.scrollCount, stopReason: discovery.stopReason });
    if (mediaDiagnosticMode) {
      const firstFreshPost = freshPosts[0];
      if (!firstFreshPost) return { posts: [], warnings: ["FACEBOOK_MEDIA_DIAGNOSTIC_NO_FRESH_POST"], durationMs: Date.now() - started, performance, ageCache };
      performance.pageOpens += await openFacebookPostPage(page, firstFreshPost.permalink, group.id, firstFreshPost.postId) ? 1 : 0;
      await captureFacebookPostRegion(page, firstFreshPost.postId, { mediaDiagnostic: true });
      await heartbeat?.();
      return { posts: [], warnings: ["FACEBOOK_MEDIA_DIAGNOSTIC_COMPLETE"], durationMs: Date.now() - started, performance, ageCache };
    }
    const remainingFreshPosts = freshPosts.filter((post) => !processedFreshPostIds.has(post.postId));
    const visionLimit = limitFacebookVisionPosts(remainingFreshPosts, Math.max(0, visionCapacity - processedFreshPostIds.size));
    if (visionLimit.remainingFreshCount > 0) logFacebookWorker("FACEBOOK_VISION_JOB_LIMIT_REACHED", { remainingFreshCount: visionLimit.remainingFreshCount });
    for (const post of visionLimit.selected) {
      try {
        signal.throwIfAborted();
        const extractionStarted = Date.now();
        const snapshot = await processDedicatedFacebookPost(post, group.id, {
          open: async (permalink) => { const navigationStarted = Date.now(); const alreadyOpen = isExpectedFacebookPostPage(page.url(), post.postId); performance.pageOpens += await openFacebookPostPage(page, permalink, group.id, post.postId) ? 1 : 0; timingFor(post.postId).dedicatedPageNavigationMs += Date.now() - navigationStarted; if (alreadyOpen) performance.dedicatedPageReuses += 1; },
          capture: async (postId) => { const region = await captureFacebookPostRegion(page, postId); logFacebookWorker("FACEBOOK_POST_REGION_FOUND", { groupId: group.id, postId, candidateCount: region.candidateCount, width: Math.round(region.box.width), height: Math.round(region.box.height), imageCount: region.imageUrls.length }); return region; },
          analyze: async (input) => { const visionStarted = Date.now(); performance.visionCalls += 1; logFacebookWorker("FACEBOOK_POST_VISION_START", { groupId: group.id, postId: input.postId }); const vision = await analyzeRegion(input, signal); timingFor(input.postId).visionMs += Date.now() - visionStarted; logFacebookWorker("FACEBOOK_POST_VISION_DONE", { groupId: group.id, postId: input.postId, isProperty: vision.isProperty, confidence: vision.confidence, detectedFieldCount: [vision.price, vision.area, vision.rooms, vision.street, vision.neighborhood, vision.district].filter((value) => value !== null).length }); return vision; },
        });
        timingFor(post.postId).extractionMs += Date.now() - extractionStarted;
        posts.push(snapshot);
      } catch (error) {
        if (error instanceof ControlledFacebookFailure) throw error;
        const reasonCode = controlledPostFailureCode(error);
        warnings.push(`${reasonCode}: post ${post.postId} nie został przetworzony.`);
        logFacebookWorker("FACEBOOK_POST_EXTRACTION_FAILED", { groupId: group.id, postId: post.postId, reasonCode });
      }
    }
    logFacebookWorker("FACEBOOK_GROUP_DONE", { groupId: group.id, posts: posts.length, durationMs: Date.now() - started });
    finalizeTimings(); return { posts, warnings: [...warnings, ...(discovered.length ? [] : ["FACEBOOK_POST_DISCOVERY_EMPTY"]), ...(posts.length || warnings.length ? [] : ["Facebook group returned no visible posts."])], durationMs: Date.now() - started, performance, ageCache };
  } finally { await context.close(); }
}

const FACEBOOK_POST_NAVIGATION_MAX_ATTEMPTS = 2;
const FACEBOOK_POST_NAVIGATION_RETRY_BACKOFF_MS = 1_000;

export async function openFacebookPostPage(page: import("playwright").Page, permalink: string, groupId: string, postId: string): Promise<boolean> {
  if (isExpectedFacebookPostPage(page.url(), postId)) return false;
  let postResponse: Awaited<ReturnType<typeof page.goto>>;
  for (let attempt = 1; ; attempt += 1) {
    try {
      postResponse = await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 });
      break;
    } catch (error) {
      if (!isFacebookNavigationTimeout(error) || attempt >= FACEBOOK_POST_NAVIGATION_MAX_ATTEMPTS) throw error;
      try {
        await assertAccessibleFacebookPage(page);
      } catch (accessError) {
        if (accessError instanceof ControlledFacebookFailure) throw accessError;
      }
      logFacebookWorker("FACEBOOK_POST_NAVIGATION_RETRY", { groupId, postId, attempt, maxAttempts: FACEBOOK_POST_NAVIGATION_MAX_ATTEMPTS, backoffMs: FACEBOOK_POST_NAVIGATION_RETRY_BACKOFF_MS });
      await page.waitForTimeout(FACEBOOK_POST_NAVIGATION_RETRY_BACKOFF_MS);
    }
  }
  await assertAccessibleFacebookPage(page);
  if (postResponse && !postResponse.ok()) throw new ControlledFacebookFailure(postResponse.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook post returned HTTP ${postResponse.status()}`);
  logFacebookWorker("FACEBOOK_POST_PAGE_OPEN", { groupId, postId, status: postResponse?.status() ?? null, finalPath: new URL(page.url()).pathname });
  await page.waitForTimeout(1_000);
  return true;
}

function isFacebookNavigationTimeout(error: unknown): boolean {
  return error instanceof playwrightErrors.TimeoutError || error instanceof Error && error.name === "TimeoutError";
}

async function assertAccessibleFacebookPage(page: import("playwright").Page): Promise<void> {
  const visibleText = (await page.locator("body").innerText({ timeout: 10_000 })).slice(0, 20_000);
  const failure = classifyFacebookSession({ url: page.url(), title: await page.title(), visibleText });
  if (failure) throw new ControlledFacebookFailure(failure, `Facebook access stopped: ${failure}`);
}

export async function waitForFacebookGroupFeed(
  page: import("playwright").Page,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const postLinkSelector = 'a[href*="/posts/"]';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await assertAccessibleFacebookPage(page);
    if (await page.locator(postLinkSelector).count() > 0) return true;
    if ((await discoverFacebookStructuredFeedPosts(page, Date.now(), 1)).length > 0) return true;
    if (attempt + 1 < attempts) await page.waitForTimeout(pollIntervalMs);
  }
  await assertAccessibleFacebookPage(page);
  return false;
}

function controlledPostFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/FACEBOOK_POST_REGION_NOT_FOUND/.test(message)) return "FACEBOOK_POST_REGION_NOT_FOUND";
  if (/FACEBOOK_POST_SCREENSHOT_TOO_LARGE/.test(message)) return "FACEBOOK_POST_SCREENSHOT_TOO_LARGE";
  if (/FACEBOOK_VISION_UNAVAILABLE/.test(message)) return "FACEBOOK_VISION_UNAVAILABLE";
  return "FACEBOOK_POST_EXTRACTION_FAILED";
}
