import { chromium } from "playwright";
import type { FacebookAgeCacheEntry, FacebookAgeCacheHit, FacebookGroupSnapshot, FacebookPerformanceMetrics, FacebookPostCacheHit, FacebookPostSnapshot, FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { createCachedFacebookPostSnapshot, emptyFacebookPerformanceMetrics, partitionFacebookPostsByCache } from "../../../features/facebook-worker/performance.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { assertWorkerFacebookGroupUrl } from "./group-reader.ts";
import { logFacebookWorker } from "./logger.ts";
import { captureFacebookPostRegion, collectFacebookPostTimeDiagnostic, detectFacebookPostAgeOnDedicatedPage, discoverFacebookPosts, discoverFacebookPostsByScrolling, isExpectedFacebookPostPage, limitFacebookVisionPosts, processDedicatedFacebookPost, resolveFacebookPostAge, resolveFacebookPostAgeFromCache, resolveFacebookPostDiscovery, type FreshDiscoveredFacebookPost } from "./post-page.ts";
import { classifyFacebookSession } from "./session.ts";

export async function fetchFacebookGroupWithBrowser(profileDir: string, group: FacebookGroupSnapshot, signal: AbortSignal, analyzeRegion: (input: { postId: string; screenshotDataUrl: string; imageUrls: string[] }, signal: AbortSignal) => Promise<FacebookVisionExtraction>, heartbeat?: () => Promise<void>, timeDiagnosticMode = false, debugMaxPosts: number | null = null, mediaDiagnosticMode = false, debugPostId: string | null = null, lookupCache?: (postIds: string[], signal: AbortSignal) => Promise<{ hits: Record<string, FacebookPostCacheHit & { publishedAt: string }>; ageHits: Record<string, FacebookAgeCacheHit> }>) {
  const started = Date.now(); const url = assertWorkerFacebookGroupUrl(group.url).toString();
  const performance: FacebookPerformanceMetrics = emptyFacebookPerformanceMetrics();
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
      await page.waitForTimeout(2_000);
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
    const discovery = await resolveFacebookPostDiscovery({ groupUrl: url, debugPostId, discover: () => discoverFacebookPostsByScrolling(page, ageReferenceMs, heartbeat, lookupKnown) }); const discovered = discovery.posts; const posts: FacebookPostSnapshot[] = []; const warnings: string[] = []; const freshPosts: FreshDiscoveredFacebookPost[] = []; let tooOldCount = 0; let unknownCount = 0; let debugSessionConfirmed = false;
    performance.postsDiscovered = discovered.length; performance.discoveredPostIds = discovered.map((post) => post.postId); performance.discoveryScrolls = discovery.scrollCount;
    performance.feedAgeHits = discovered.filter((post) => post.discoveredPublishedAt !== null).length;
    performance.earlyStopOldBoundaryCount = discovery.stopReason === "OLDER_THAN_72H" || discovery.stopReason === "KNOWN_OLD_SEQUENCE" ? 1 : 0;
    if (!debugPostId && lookupCache) await lookupAndRemember(discovered.map((post) => post.postId));
    const partitioned = partitionFacebookPostsByCache(discovered, cacheHits, ageReferenceMs);
    for (const { post, hit } of partitioned.cached) {
      posts.push(createCachedFacebookPostSnapshot(post, group, hit));
      performance.visionCacheHits += 1; performance.knownPostSkips += 1; performance.duplicatePostIdsSkipped += hit.scope === "RUN" ? 1 : 0;
    }
    for (const [order, post] of partitioned.uncached.entries()) {
      logFacebookWorker("FACEBOOK_POST_DISCOVERED", { groupId: group.id, postId: post.postId, order, freshnessFailure: post.freshnessFailure });
      const cachedAge = !debugPostId && !post.discoveredPublishedAt ? ageCacheHits[post.postId] : undefined;
      const age = cachedAge ? resolveFacebookPostAgeFromCache(post, cachedAge, ageReferenceMs) : await resolveFacebookPostAge(post, ageReferenceMs, async () => {
          performance.agePageFallbacks += 1;
          performance.pageOpens += await openFacebookPostPage(page, post.permalink, group.id, post.postId) ? 1 : 0;
          if (debugPostId && !debugSessionConfirmed) { logFacebookWorker("FACEBOOK_SESSION_OK", { groupId: group.id }); debugSessionConfirmed = true; }
          const detectedAge = await detectFacebookPostAgeOnDedicatedPage(page, post.postId, ageReferenceMs);
          await heartbeat?.();
          return detectedAge;
        });
      if (cachedAge) performance.ageCacheHits += 1;
      if (age.decision === "TOO_OLD" && (post.discoveredPublishedAt || cachedAge)) performance.oldPostsSkippedBeforePageOpen += 1;
      ageCache.push({ postId: post.postId, checkedAt: cachedAge?.checkedAt ?? new Date(ageReferenceMs).toISOString(), publishedAt: age.post.discoveredPublishedAt, decision: age.decision === "PROCESS" ? "FRESH" : age.decision, source: cachedAge?.source ?? (age.source === "AGE_CACHE" ? "POST_PAGE" : age.source) });
      logFacebookWorker("FACEBOOK_POST_AGE_DETECTED", { postId: post.postId, source: age.source, ageHours: age.ageHours === null ? null : Math.round(age.ageHours * 100) / 100, decision: age.decision });
      if (age.post.freshnessFailure) {
        if (age.post.freshnessFailure === "FACEBOOK_POST_TOO_OLD") tooOldCount += 1;
        else unknownCount += 1;
        warnings.push(`${age.post.freshnessFailure}: post ${post.postId} nie został przetworzony.`);
        logFacebookWorker("FACEBOOK_POST_EXTRACTION_FAILED", { groupId: group.id, postId: post.postId, reasonCode: age.post.freshnessFailure });
      } else {
        freshPosts.push(age.post);
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
    const visionLimit = limitFacebookVisionPosts(freshPosts, debugPostId ? 1 : debugMaxPosts ?? undefined);
    if (visionLimit.remainingFreshCount > 0) logFacebookWorker("FACEBOOK_VISION_JOB_LIMIT_REACHED", { remainingFreshCount: visionLimit.remainingFreshCount });
    for (const post of visionLimit.selected) {
      try {
        signal.throwIfAborted();
        const snapshot = await processDedicatedFacebookPost(post, group.id, {
          open: async (permalink) => { performance.pageOpens += await openFacebookPostPage(page, permalink, group.id, post.postId) ? 1 : 0; },
          capture: async (postId) => { const region = await captureFacebookPostRegion(page, postId); logFacebookWorker("FACEBOOK_POST_REGION_FOUND", { groupId: group.id, postId, candidateCount: region.candidateCount, width: Math.round(region.box.width), height: Math.round(region.box.height), imageCount: region.imageUrls.length }); return region; },
          analyze: async (input) => { performance.visionCalls += 1; logFacebookWorker("FACEBOOK_POST_VISION_START", { groupId: group.id, postId: input.postId }); const vision = await analyzeRegion(input, signal); logFacebookWorker("FACEBOOK_POST_VISION_DONE", { groupId: group.id, postId: input.postId, isProperty: vision.isProperty, confidence: vision.confidence, detectedFieldCount: [vision.price, vision.area, vision.rooms, vision.street, vision.neighborhood, vision.district].filter((value) => value !== null).length }); return vision; },
        });
        posts.push(snapshot);
      } catch (error) {
        if (error instanceof ControlledFacebookFailure) throw error;
        const reasonCode = controlledPostFailureCode(error);
        warnings.push(`${reasonCode}: post ${post.postId} nie został przetworzony.`);
        logFacebookWorker("FACEBOOK_POST_EXTRACTION_FAILED", { groupId: group.id, postId: post.postId, reasonCode });
      }
    }
    logFacebookWorker("FACEBOOK_GROUP_DONE", { groupId: group.id, posts: posts.length, durationMs: Date.now() - started });
    return { posts, warnings: [...warnings, ...(discovered.length ? [] : ["FACEBOOK_POST_DISCOVERY_EMPTY"]), ...(posts.length || warnings.length ? [] : ["Facebook group returned no visible posts."])], durationMs: Date.now() - started, performance, ageCache };
  } finally { await context.close(); }
}

async function openFacebookPostPage(page: import("playwright").Page, permalink: string, groupId: string, postId: string): Promise<boolean> {
  if (isExpectedFacebookPostPage(page.url(), postId)) return false;
  const postResponse = await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertAccessibleFacebookPage(page);
  if (postResponse && !postResponse.ok()) throw new ControlledFacebookFailure(postResponse.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook post returned HTTP ${postResponse.status()}`);
  logFacebookWorker("FACEBOOK_POST_PAGE_OPEN", { groupId, postId, status: postResponse?.status() ?? null, finalPath: new URL(page.url()).pathname });
  await page.waitForTimeout(1_000);
  return true;
}

async function assertAccessibleFacebookPage(page: import("playwright").Page): Promise<void> {
  const visibleText = (await page.locator("body").innerText({ timeout: 10_000 })).slice(0, 20_000);
  const failure = classifyFacebookSession({ url: page.url(), title: await page.title(), visibleText });
  if (failure) throw new ControlledFacebookFailure(failure, `Facebook access stopped: ${failure}`);
}

function controlledPostFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/FACEBOOK_POST_REGION_NOT_FOUND/.test(message)) return "FACEBOOK_POST_REGION_NOT_FOUND";
  if (/FACEBOOK_POST_SCREENSHOT_TOO_LARGE/.test(message)) return "FACEBOOK_POST_SCREENSHOT_TOO_LARGE";
  if (/FACEBOOK_VISION_UNAVAILABLE/.test(message)) return "FACEBOOK_VISION_UNAVAILABLE";
  return "FACEBOOK_POST_EXTRACTION_FAILED";
}
