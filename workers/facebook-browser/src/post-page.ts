import type { Page } from "playwright";
import type { FacebookPostSnapshot, FacebookVisionExtraction } from "../../../features/facebook-worker/types.ts";

export const MAX_FACEBOOK_POSTS_PER_JOB = 5;

export type DiscoveredFacebookPost = { postId: string; permalink: string };
export type FacebookPostRegion = { screenshotDataUrl: string; imageUrls: string[]; publishedAt: string | null; box: { x: number; y: number; width: number; height: number }; candidateCount: number };

export async function processDedicatedFacebookPost(post: DiscoveredFacebookPost, groupId: string, dependencies: { open: (permalink: string) => Promise<void>; capture: (postId: string) => Promise<FacebookPostRegion>; analyze: (input: { postId: string; screenshotDataUrl: string }) => Promise<FacebookVisionExtraction> }): Promise<FacebookPostSnapshot> {
  await dependencies.open(post.permalink);
  const region = await dependencies.capture(post.postId);
  const vision = await dependencies.analyze({ postId: post.postId, screenshotDataUrl: region.screenshotDataUrl });
  return { postId: post.postId, groupId, permalink: post.permalink, text: vision.visibleText ?? "", imageUrls: region.imageUrls, publishedAt: region.publishedAt, vision };
}

export function canonicalFacebookPostUrl(value: string, expectedPostId?: string): DiscoveredFacebookPost | null {
  try {
    const url = new URL(value, "https://www.facebook.com");
    if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/groups\/[^/]+\/posts\/(\d+)\/?$/i);
    if (!match || expectedPostId && match[1] !== expectedPostId) return null;
    url.hostname = "www.facebook.com"; url.pathname = url.pathname.replace(/\/$/, "") + "/"; url.search = ""; url.hash = "";
    return { postId: match[1], permalink: url.toString() };
  } catch { return null; }
}

export function discoverPostLinksFromHrefs(hrefs: string[], limit = MAX_FACEBOOK_POSTS_PER_JOB): DiscoveredFacebookPost[] {
  const unique = new Map<string, DiscoveredFacebookPost>();
  for (const href of hrefs) {
    const post = canonicalFacebookPostUrl(href);
    if (post && !unique.has(post.postId)) unique.set(post.postId, post);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export async function discoverFacebookPosts(page: Page, limit = MAX_FACEBOOK_POSTS_PER_JOB): Promise<DiscoveredFacebookPost[]> {
  const hrefs = await page.locator('a[href*="/groups/"][href*="/posts/"]').evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
  return discoverPostLinksFromHrefs(hrefs, limit);
}

export async function captureFacebookPostRegion(page: Page, postId: string): Promise<FacebookPostRegion> {
  const region = await page.evaluate((targetPostId) => {
    const postPath = new RegExp(`/groups/[^/]+/posts/${targetPostId}/?$`, "i");
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/groups/"][href*="/posts/"]')).filter((link) => { const url = new URL(link.href, location.href); return postPath.test(url.pathname) && !url.searchParams.has("comment_id"); });
    const roots: Element[] = [];
    for (const link of links) {
      let current: Element | null = link;
      for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) if (!roots.includes(current)) roots.push(current);
    }
    const candidates = roots.flatMap((root) => {
      const rect = root.getBoundingClientRect();
      if (rect.width < 280 || rect.width > 1_200 || rect.height < 100 || rect.height > 1_600) return [];
      const excluded = (element: Element) => {
        if (element.closest('button,[role="button"],[role="toolbar"],form,[data-testid*="comment" i],[aria-label*="comment" i],[aria-label*="komentar" i]')) return true;
        const nestedArticle = element.closest('[role="article"]');
        if (nestedArticle && nestedArticle !== root && nestedArticle.getBoundingClientRect().height < 220) return true;
        return false;
      };
      const textNodes = Array.from(root.querySelectorAll<HTMLElement>('[data-ad-comet-preview="message"],[data-ad-preview="message"],[data-testid="post_message"],[data-testid="post-message"],div[dir="auto"],p,[data-lexical-text="true"]'))
        .filter((element) => !excluded(element) && element.innerText.trim().length >= 12 && !element.querySelector('a,button,[role="button"],[role="toolbar"]'));
      const media = Array.from(root.querySelectorAll<HTMLElement>('img[data-visualcompletion="media-vc-image"],a[href*="/photo"] img,video'))
        .filter((element) => !excluded(element) && element.getBoundingClientRect().width >= 120 && element.getBoundingClientRect().height >= 80);
      const visualNodes = [...textNodes, ...media];
      if (!visualNodes.length) return [];
      const boxes = visualNodes.map((element) => element.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
      if (!boxes.length) return [];
      const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - 8); const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) + window.scrollY - 8);
      const right = Math.min(document.documentElement.scrollWidth, Math.max(...boxes.map((box) => box.right)) + 8); const bottom = Math.min(document.documentElement.scrollHeight, Math.max(...boxes.map((box) => box.bottom + window.scrollY)) + 8);
      const contentLength = textNodes.reduce((total, element) => total + Math.min(element.innerText.trim().length, 2_000), 0);
      const score = contentLength + media.length * 250 - Math.max(0, visualNodes.length - 20) * 20;
      const imageUrls = media.flatMap((element) => element instanceof HTMLImageElement && element.src ? [element.src] : []);
      const time = root.querySelector<HTMLTimeElement>("time[datetime]")?.dateTime ?? null;
      return [{ score, area: rect.width * rect.height, box: { x, y, width: right - x, height: bottom - y }, imageUrls, publishedAt: time }];
    }).sort((left, right) => right.score - left.score || left.area - right.area);
    if (!candidates.length || candidates[0].box.width < 120 || candidates[0].box.height < 40 || candidates[0].box.height > 1_200) return null;
    if (candidates[1] && candidates[0].score === candidates[1].score && Math.abs(candidates[0].area - candidates[1].area) < 100) return null;
    return { ...candidates[0], candidateCount: candidates.length };
  }, postId);
  if (!region) throw new Error("FACEBOOK_POST_REGION_NOT_FOUND");
  const screenshot = await page.screenshot({ type: "jpeg", quality: 65, clip: region.box, animations: "disabled" });
  const screenshotDataUrl = `data:image/jpeg;base64,${screenshot.toString("base64")}`;
  if (screenshotDataUrl.length > 900_000) throw new Error("FACEBOOK_POST_SCREENSHOT_TOO_LARGE");
  return { screenshotDataUrl, imageUrls: [...new Set(region.imageUrls)].slice(0, 5), publishedAt: region.publishedAt, box: region.box, candidateCount: region.candidateCount };
}
