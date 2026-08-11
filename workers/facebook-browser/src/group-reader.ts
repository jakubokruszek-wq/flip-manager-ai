import type { Page } from "playwright";
import type { FacebookGroupSnapshot, FacebookPostSnapshot } from "../../../features/facebook-worker/types.ts";
import { normalizeFacebookPosts, type RawFacebookPost } from "./post-extractor.ts";

export function assertWorkerFacebookGroupUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname) || !/^\/groups\/[^/]+/i.test(url.pathname)) throw new Error("FACEBOOK_GROUP_URL_NOT_ALLOWED");
  return url;
}

export async function readFacebookGroup(page: Page, group: FacebookGroupSnapshot): Promise<FacebookPostSnapshot[]> {
  assertWorkerFacebookGroupUrl(group.url);
  await page.waitForTimeout(2_000);
  const candidates = await page.locator('[role="article"]').evaluateAll((articles) => articles.slice(0, 20).map((article): RawFacebookPost => {
    const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"],a[href*="/permalink/"]'));
    const images = Array.from(article.querySelectorAll<HTMLImageElement>("img[src]")).map((image) => image.src).filter(Boolean);
    const time = article.querySelector<HTMLTimeElement>("time[datetime]");
    return { permalink: anchors[0]?.href ?? null, text: article.textContent ?? "", imageUrls: images, publishedAt: time?.dateTime ?? null };
  }));
  return normalizeFacebookPosts(group.id, candidates);
}

