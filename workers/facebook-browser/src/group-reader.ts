import type { Page } from "playwright";
import type { FacebookGroupSnapshot, FacebookPostSnapshot } from "../../../features/facebook-worker/types.ts";
import { facebookPostExtractionWarnings, normalizeFacebookPosts, type RawFacebookPost } from "./post-extractor.ts";
import { logFacebookWorker } from "./logger.ts";

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
      const excludedByUiOrComments = (element: Element) => {
        const excluded = element.closest('button,a,[role="button"],[role="toolbar"],form,[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]');
        return excluded !== null && excluded !== article;
      };
      const cleanedText = (value: string) => value
        .replace(/(?:^|\s)(?:Lubię to!?|Odpowiedz|Udostępnij|Like|Reply|Share)(?=\s|$)/giu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const isUiOnly = (value: string) => /^(?:Lubię to!?|Odpowiedz|Udostępnij|Like|Reply|Share|\d+\s*(?:min|godz|dni?)\.?)+$/iu.test(value);
      const diagnostics = (element: Element, source: "dedicated" | "fallback", length: number, score: number) => ({
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        dataAttributes: Array.from(element.attributes).map((attribute) => attribute.name).filter((name) => name.startsWith("data-")).slice(0, 8),
        length, source, score,
      });
      const anchors = Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/posts/"],a[href*="/permalink/"]')).filter(belongsToMainPost);
      const permalink = anchors.find((anchor) => !new URL(anchor.href, location.href).searchParams.has("comment_id"))?.href ?? anchors[0]?.href ?? null;
      const dedicatedNodes = Array.from(article.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"],[data-testid="story-subtitle"]'))
        .filter((element) => belongsToMainPost(element) && !excludedByUiOrComments(element));
      const candidateElements = Array.from(article.querySelectorAll<HTMLElement>('div[dir="auto"],span[dir="auto"],p,[data-lexical-text="true"]'))
        .filter((element) => belongsToMainPost(element) && !excludedByUiOrComments(element));
      const bodyCandidates = [...dedicatedNodes.map((element) => ({ element, source: "dedicated" as const })), ...candidateElements.map((element) => ({ element, source: "fallback" as const }))]
        .map(({ element, source }) => {
          const text = cleanedText(element.innerText);
          const interactiveChildren = element.querySelector('a,button,[role="button"],[role="toolbar"]') !== null;
          const timestampLike = /^(?:\d+\s*(?:min|godz|dni?)\.?|wczoraj|przed chwilą)$/iu.test(text);
          const score = text.length + (/[.!?]/u.test(text) ? 10 : 0) + (/\d/u.test(text) ? 5 : 0) + (source === "dedicated" ? 1_000 : 0) - (interactiveChildren ? 1_000 : 0);
          return { element, source, text, score, valid: text.length >= 12 && !isUiOnly(text) && !timestampLike && !interactiveChildren };
        })
        .filter((candidate) => candidate.valid);
      const uniqueCandidates = [...new Map(bodyCandidates.map((candidate) => [candidate.text, candidate])).values()]
        .sort((left, right) => right.score - left.score);
      const best = uniqueCandidates[0];
      const message = best?.text ?? "";
      const images = Array.from(article.querySelectorAll<HTMLImageElement>('a[href*="/photo"] img[src],a[href*="/photos/"] img[src],img[data-visualcompletion="media-vc-image"][src]'))
        .filter((image) => belongsToMainPost(image) && !/(zdjęcie profilowe|profile picture)/i.test(image.alt))
        .map((image) => image.src)
        .filter(Boolean);
      const time = Array.from(article.querySelectorAll<HTMLTimeElement>("time[datetime]")).find(belongsToMainPost);
      return { permalink, text: message, imageUrls: images, publishedAt: time?.dateTime ?? null, extractionError: message || images.length ? null : "FACEBOOK_POST_BODY_NOT_FOUND", bodyDiagnostics: { candidateCount: uniqueCandidates.length, candidates: uniqueCandidates.slice(0, 10).map((candidate) => diagnostics(candidate.element, candidate.source, candidate.text.length, candidate.score)) } };
    }));
  candidates.forEach((candidate, articleIndex) => logFacebookWorker("FACEBOOK_POST_BODY_DIAGNOSTIC", { groupId: group.id, articleIndex, candidateCount: candidate.bodyDiagnostics?.candidateCount ?? 0, candidates: candidate.bodyDiagnostics?.candidates ?? [], selectedLength: candidate.text?.length ?? 0, extractionError: candidate.extractionError ?? null }));
  return { posts: normalizeFacebookPosts(group.id, candidates), warnings: facebookPostExtractionWarnings(candidates) };
}
