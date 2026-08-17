import { chromium } from "playwright";
import type { FacebookGroupSnapshot, FacebookPostSnapshot, FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { assertWorkerFacebookGroupUrl } from "./group-reader.ts";
import { logFacebookWorker } from "./logger.ts";
import { captureFacebookPostRegion, collectFacebookPostTimeDiagnostic, detectFacebookPostAgeOnDedicatedPage, discoverFacebookPosts, discoverFacebookPostsByScrolling, limitFacebookVisionPosts, processDedicatedFacebookPost, resolveFacebookPostAge, type FreshDiscoveredFacebookPost } from "./post-page.ts";
import { classifyFacebookSession } from "./session.ts";

export async function fetchFacebookGroupWithBrowser(profileDir: string, group: FacebookGroupSnapshot, signal: AbortSignal, analyzeRegion: (input: { postId: string; screenshotDataUrl: string; imageUrls: string[] }, signal: AbortSignal) => Promise<FacebookVisionExtraction>, heartbeat?: () => Promise<void>, timeDiagnosticMode = false, debugMaxPosts: number | null = null, mediaDiagnosticMode = false) {
  const started = Date.now(); const url = assertWorkerFacebookGroupUrl(group.url).toString();
  logFacebookWorker("FACEBOOK_BROWSER_START", { groupId: group.id });
  const context = await chromium.launchPersistentContext(profileDir, { headless: true, locale: "pl-PL" });
  try {
    signal.throwIfAborted(); const page = context.pages()[0] ?? await context.newPage();
    logFacebookWorker("FACEBOOK_GROUP_START", { groupId: group.id });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    signal.throwIfAborted();
    await assertAccessibleFacebookPage(page);
    if (response && !response.ok()) throw new ControlledFacebookFailure(response.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook group returned HTTP ${response.status()}`);
    logFacebookWorker("FACEBOOK_SESSION_OK", { groupId: group.id });
    await page.waitForTimeout(2_000);
    const ageReferenceMs = Date.now();
    if (timeDiagnosticMode) {
      const firstPost = (await discoverFacebookPosts(page, 1, ageReferenceMs))[0];
      if (!firstPost) return { posts: [], warnings: ["FACEBOOK_POST_DISCOVERY_EMPTY"], durationMs: Date.now() - started };
      logFacebookWorker("FACEBOOK_POST_DISCOVERED", { groupId: group.id, postId: firstPost.postId, order: 0, freshnessFailure: firstPost.freshnessFailure });
      await openFacebookPostPage(page, firstPost.permalink, group.id, firstPost.postId);
      const timeDiagnostic = await collectFacebookPostTimeDiagnostic(page, firstPost.postId, ageReferenceMs);
      logFacebookWorker("FACEBOOK_POST_TIME_DIAGNOSTIC", timeDiagnostic);
      await heartbeat?.();
      return { posts: [], warnings: ["FACEBOOK_TIME_DIAGNOSTIC_COMPLETE"], durationMs: Date.now() - started };
    }
    const discovery = await discoverFacebookPostsByScrolling(page, ageReferenceMs, heartbeat); const discovered = discovery.posts; const posts: FacebookPostSnapshot[] = []; const warnings: string[] = []; const freshPosts: FreshDiscoveredFacebookPost[] = []; let tooOldCount = 0; let unknownCount = 0;
    for (const [order, post] of discovered.entries()) {
      logFacebookWorker("FACEBOOK_POST_DISCOVERED", { groupId: group.id, postId: post.postId, order, freshnessFailure: post.freshnessFailure });
      const age = await resolveFacebookPostAge(post, ageReferenceMs, async () => {
        await openFacebookPostPage(page, post.permalink, group.id, post.postId);
        const detectedAge = await detectFacebookPostAgeOnDedicatedPage(page, post.postId, ageReferenceMs);
        await heartbeat?.();
        return detectedAge;
      });
      logFacebookWorker("FACEBOOK_POST_AGE_DETECTED", { postId: post.postId, source: age.source, ageHours: age.ageHours === null ? null : Math.round(age.ageHours * 100) / 100, decision: age.decision });
      if (age.post.freshnessFailure) {
        if (age.post.freshnessFailure === "FACEBOOK_POST_TOO_OLD") tooOldCount += 1;
        else unknownCount += 1;
        warnings.push(`${age.post.freshnessFailure}: post ${post.postId} nie został przetworzony.`);
        logFacebookWorker("FACEBOOK_POST_EXTRACTION_FAILED", { groupId: group.id, postId: post.postId, reasonCode: age.post.freshnessFailure });
      } else {
        freshPosts.push(age.post);
        if (mediaDiagnosticMode || debugMaxPosts !== null && freshPosts.length >= debugMaxPosts) break;
      }
    }
    logFacebookWorker("FACEBOOK_DISCOVERY_COMPLETE", { discoveredTotal: discovered.length, freshCount: freshPosts.length, tooOldCount, unknownCount, scrollCount: discovery.scrollCount, stopReason: discovery.stopReason });
    if (mediaDiagnosticMode) {
      const firstFreshPost = freshPosts[0];
      if (!firstFreshPost) return { posts: [], warnings: ["FACEBOOK_MEDIA_DIAGNOSTIC_NO_FRESH_POST"], durationMs: Date.now() - started };
      await openFacebookPostPage(page, firstFreshPost.permalink, group.id, firstFreshPost.postId);
      await captureFacebookPostRegion(page, firstFreshPost.postId, { mediaDiagnostic: true });
      await heartbeat?.();
      return { posts: [], warnings: ["FACEBOOK_MEDIA_DIAGNOSTIC_COMPLETE"], durationMs: Date.now() - started };
    }
    const visionLimit = limitFacebookVisionPosts(freshPosts, debugMaxPosts ?? undefined);
    if (visionLimit.remainingFreshCount > 0) logFacebookWorker("FACEBOOK_VISION_JOB_LIMIT_REACHED", { remainingFreshCount: visionLimit.remainingFreshCount });
    for (const post of visionLimit.selected) {
      try {
        signal.throwIfAborted();
        const snapshot = await processDedicatedFacebookPost(post, group.id, {
          open: async (permalink) => openFacebookPostPage(page, permalink, group.id, post.postId),
          capture: async (postId) => { const region = await captureFacebookPostRegion(page, postId); logFacebookWorker("FACEBOOK_POST_REGION_FOUND", { groupId: group.id, postId, candidateCount: region.candidateCount, width: Math.round(region.box.width), height: Math.round(region.box.height), imageCount: region.imageUrls.length }); return region; },
          analyze: async (input) => { logFacebookWorker("FACEBOOK_POST_VISION_START", { groupId: group.id, postId: input.postId }); const vision = await analyzeRegion(input, signal); logFacebookWorker("FACEBOOK_POST_VISION_DONE", { groupId: group.id, postId: input.postId, isProperty: vision.isProperty, confidence: vision.confidence, detectedFieldCount: [vision.price, vision.area, vision.rooms, vision.street, vision.neighborhood, vision.district].filter((value) => value !== null).length }); return vision; },
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
    return { posts, warnings: [...warnings, ...(discovered.length ? [] : ["FACEBOOK_POST_DISCOVERY_EMPTY"]), ...(posts.length || warnings.length ? [] : ["Facebook group returned no visible posts."])], durationMs: Date.now() - started };
  } finally { await context.close(); }
}

async function openFacebookPostPage(page: import("playwright").Page, permalink: string, groupId: string, postId: string): Promise<void> {
  const postResponse = await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await assertAccessibleFacebookPage(page);
  if (postResponse && !postResponse.ok()) throw new ControlledFacebookFailure(postResponse.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook post returned HTTP ${postResponse.status()}`);
  logFacebookWorker("FACEBOOK_POST_PAGE_OPEN", { groupId, postId, status: postResponse?.status() ?? null, finalPath: new URL(page.url()).pathname });
  await page.waitForTimeout(1_000);
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
