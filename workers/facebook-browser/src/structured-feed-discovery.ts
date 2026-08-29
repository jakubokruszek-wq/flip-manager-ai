import type { Page } from "playwright";
import { facebookPostFreshnessFailure, type FreshDiscoveredFacebookPost } from "./post-page.ts";

export type FacebookStructuredFeedRecord = {
  postId: string;
  url: string;
  publishedAt: string | number | null;
  unsafeContext: boolean;
  text?: string | null;
};

function exactStructuredPostUrl(value: string, expectedGroupId: string, expectedPostId: string, sourceType: "GROUP" | "PROFILE" = "GROUP"): string | null {
  try {
    const url = new URL(value, "https://www.facebook.com");
    if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
    const match = sourceType === "GROUP" ? url.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)\/?$/i) : url.pathname.match(/^\/([^/]+)\/posts\/(\d+)\/?$/i);
    if (!match || match[1] !== expectedGroupId || match[2] !== expectedPostId) return null;
    return sourceType === "GROUP" ? `https://www.facebook.com/groups/${expectedGroupId}/posts/${expectedPostId}/` : `https://www.facebook.com/${expectedGroupId}/posts/${expectedPostId}/`;
  } catch {
    return null;
  }
}

function structuredTimestamp(value: string | number | null): string | null {
  if (value === null) return null;
  const raw = String(value).trim();
  if (/^\d{9,13}$/.test(raw)) {
    const numeric = Number(raw);
    const milliseconds = raw.length <= 10 ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function resolveFacebookStructuredFeedRecords(
  records: FacebookStructuredFeedRecord[],
  expectedGroupId: string,
  nowMs = Date.now(),
  limit = 50,
  sourceType: "GROUP" | "PROFILE" = "GROUP",
): FreshDiscoveredFacebookPost[] {
  const unique = new Map<string, FreshDiscoveredFacebookPost>();
  for (const record of records) {
    if (record.unsafeContext || !/^\d+$/.test(record.postId)) continue;
    const permalink = exactStructuredPostUrl(record.url, expectedGroupId, record.postId, sourceType);
    if (!permalink) continue;
    const discoveredPublishedAt = structuredTimestamp(record.publishedAt);
    const candidate: FreshDiscoveredFacebookPost & { discoveredText?: string | null } = {
      postId: record.postId,
      permalink,
      discoveredPublishedAt,
      freshnessFailure: facebookPostFreshnessFailure(discoveredPublishedAt, nowMs),
      discoveredText: typeof record.text === "string" ? record.text.slice(0, 4_000) : null,
    };
    const existing = unique.get(record.postId);
    if (!existing || !existing.discoveredPublishedAt && candidate.discoveredPublishedAt) unique.set(record.postId, candidate);
    if (unique.size >= limit) break;
  }
  return [...unique.values()];
}

export async function discoverFacebookStructuredFeedPosts(
  page: Page,
  nowMs = Date.now(),
  limit = 50,
): Promise<FreshDiscoveredFacebookPost[]> {
  const currentPath = new URL(page.url()).pathname;
  const groupMatch = currentPath.match(/^\/groups\/([^/]+)/i);
  const currentUrl = new URL(page.url());
  const groupId = groupMatch?.[1] ?? currentUrl.searchParams.get("id") ?? currentPath.match(/^\/([^/]+)\/?$/i)?.[1];
  const sourceType = groupMatch ? "GROUP" : "PROFILE";
  if (!groupId) return [];
  const records = await page.evaluate(() => {
    const result: FacebookStructuredFeedRecord[] = [];
    const postIdKey = /^(?:post_id|story_fbid|top_level_post_id|mf_story_key)$/i;
    const urlKey = /^(?:permalink_url|url|wwwURL)$/i;
      const timestampKey = /^(?:creation_time|publish_time|timestamp)$/i;
      const textKey = /^(?:message|story_message|text|description|body)$/i;
    const unsafePath = /comment|reply|attached_story|shared_story|reshar|recommend|sidebar/i;
    const visit = (value: unknown, path: string[], depth: number): void => {
      if (!value || typeof value !== "object" || depth > 28 || result.length >= 200) return;
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, [...path, String(index)], depth + 1));
        return;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      const postId = entries.find(([key, item]) => postIdKey.test(key) && (typeof item === "string" || typeof item === "number"))?.[1];
      const urls = entries.filter(([key, item]) => urlKey.test(key) && typeof item === "string").map(([, item]) => String(item));
      const publishedAt = entries.find(([key, item]) => timestampKey.test(key) && (typeof item === "string" || typeof item === "number"))?.[1] ?? null;
      const text = entries.find(([key, item]) => textKey.test(key) && typeof item === "string" && String(item).trim().length > 0)?.[1] ?? null;
      if (postId !== undefined) {
        for (const url of urls) result.push({ postId: String(postId), url, publishedAt: typeof publishedAt === "string" || typeof publishedAt === "number" ? publishedAt : null, unsafeContext: path.some((part) => unsafePath.test(part)), text: typeof text === "string" ? text : null });
      }
      for (const [key, item] of entries) if (item && typeof item === "object") visit(item, [...path, key], depth + 1);
    };
    for (const script of Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="application/json"],script[type="application/ld+json"]'))) {
      const source = script.textContent ?? "";
      if (!source || source.length > 3_000_000) continue;
      try { visit(JSON.parse(source), [], 0); } catch { /* malformed inline data is not a discovery source */ }
    }
    return result;
  });
  return resolveFacebookStructuredFeedRecords(records, groupId, nowMs, limit, sourceType);
}
