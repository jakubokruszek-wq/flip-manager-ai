import { chromium } from "playwright";
import type { FacebookGroupSnapshot, FacebookPostSnapshot, FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";
import { ControlledFacebookFailure } from "./errors.ts";
import { assertWorkerFacebookGroupUrl } from "./group-reader.ts";
import { logFacebookWorker } from "./logger.ts";
import { captureFacebookPostRegion, discoverFacebookPosts, processDedicatedFacebookPost } from "./post-page.ts";
import { classifyFacebookSession } from "./session.ts";

export async function fetchFacebookGroupWithBrowser(profileDir: string, group: FacebookGroupSnapshot, signal: AbortSignal, analyzeRegion: (input: { postId: string; screenshotDataUrl: string }, signal: AbortSignal) => Promise<FacebookVisionExtraction>) {
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
    const discovered = await discoverFacebookPosts(page); const posts: FacebookPostSnapshot[] = []; const warnings: string[] = [];
    discovered.forEach((post, order) => logFacebookWorker("FACEBOOK_POST_DISCOVERED", { groupId: group.id, postId: post.postId, order }));
    for (const post of discovered) {
      try {
        signal.throwIfAborted();
        const snapshot = await processDedicatedFacebookPost(post, group.id, {
          open: async (permalink) => { const postResponse = await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 60_000 }); await assertAccessibleFacebookPage(page); if (postResponse && !postResponse.ok()) throw new ControlledFacebookFailure(postResponse.status() === 403 ? "FACEBOOK_ACCESS_DENIED" : "FACEBOOK_GROUP_UNAVAILABLE", `Facebook post returned HTTP ${postResponse.status()}`); logFacebookWorker("FACEBOOK_POST_PAGE_OPEN", { groupId: group.id, postId: post.postId, status: postResponse?.status() ?? null, finalPath: new URL(page.url()).pathname }); await page.waitForTimeout(1_000); },
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
