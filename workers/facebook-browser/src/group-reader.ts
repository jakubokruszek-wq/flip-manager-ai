import type { Page } from "playwright";
import type { FacebookGroupSnapshot, FacebookPostSnapshot } from "../../../features/facebook-worker/types.ts";
import { facebookPostExtractionWarnings, normalizeFacebookPosts, type RawFacebookPost } from "./post-extractor.ts";

export function assertWorkerFacebookGroupUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname) || !/^\/groups\/[^/]+/i.test(url.pathname)) throw new Error("FACEBOOK_GROUP_URL_NOT_ALLOWED");
  return url;
}

export async function readFacebookGroup(page: Page, group: FacebookGroupSnapshot): Promise<{ posts: FacebookPostSnapshot[]; warnings: string[] }> {
  assertWorkerFacebookGroupUrl(group.url);
  await page.waitForTimeout(2_000);
  const candidates = await page.locator('[role="article"]').evaluateAll((articles) => articles
    .filter((article) => article.parentElement?.closest('[role="article"]') === null)
    .slice(0, 20)
    .map((article): RawFacebookPost => {
      const belongsToMainPost = (element: Element) => element.closest('[role="article"]') === article;
      const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"],a[href*="/permalink/"]')).filter(belongsToMainPost);
      const permalink = anchors.find((anchor) => !new URL(anchor.href, location.href).searchParams.has("comment_id"))?.href ?? anchors[0]?.href ?? null;
      const messageNodes = Array.from(article.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"]')).filter(belongsToMainPost);
      const message = messageNodes.map((node) => node.innerText.trim()).find(Boolean) ?? "";
      const images = Array.from(article.querySelectorAll<HTMLImageElement>('a[href*="/photo"] img[src],a[href*="/photos/"] img[src],img[data-visualcompletion="media-vc-image"][src]'))
        .filter((image) => belongsToMainPost(image) && !/(zdjęcie profilowe|profile picture)/i.test(image.alt))
        .map((image) => image.src)
        .filter(Boolean);
      const time = Array.from(article.querySelectorAll<HTMLTimeElement>("time[datetime]")).find(belongsToMainPost);
      return { permalink, text: message, imageUrls: images, publishedAt: time?.dateTime ?? null, extractionError: message || images.length ? null : "FACEBOOK_POST_BODY_NOT_FOUND" };
    }));
  return { posts: normalizeFacebookPosts(group.id, candidates), warnings: facebookPostExtractionWarnings(candidates) };
}
