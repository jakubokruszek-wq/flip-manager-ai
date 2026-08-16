import type { FacebookPostSnapshot } from "../../../features/facebook-worker/types.ts";

export type RawFacebookPost = { permalink?: string | null; text?: string | null; imageUrls?: string[]; publishedAt?: string | null; extractionError?: "FACEBOOK_POST_BODY_NOT_FOUND" | null };

export function normalizeFacebookPosts(groupId: string, candidates: RawFacebookPost[]): FacebookPostSnapshot[] {
  const seen = new Set<string>(); const posts: FacebookPostSnapshot[] = [];
  for (const candidate of candidates) {
    if (posts.length >= 20) break;
    if (candidate.extractionError) continue;
    const permalink = normalizePermalink(candidate.permalink);
    const postId = permalink ? extractPostId(permalink) : null;
    const text = cleanFacebookPostText(candidate.text ?? "");
    const imageUrls = (candidate.imageUrls ?? []).filter(isHttps).slice(0, 5);
    if (!text && imageUrls.length === 0) continue;
    const key = postId ?? permalink ?? text.slice(0, 200);
    if (!key || seen.has(key)) continue; seen.add(key);
    posts.push({ postId, groupId, permalink, text: text.slice(0, 2_000), imageUrls, publishedAt: normalizeDate(candidate.publishedAt) });
  }
  return posts;
}

export function facebookPostExtractionWarnings(candidates: RawFacebookPost[]): string[] {
  const failed = candidates.filter((candidate) => candidate.extractionError === "FACEBOOK_POST_BODY_NOT_FOUND").length;
  return failed > 0 ? [`FACEBOOK_POST_BODY_NOT_FOUND: pominięto ${failed} niejednoznacznych kontenerów.`] : [];
}

export function cleanFacebookPostText(value: string): string {
  return value
    .replace(/(?:^|\s)(?:Lubię to!?|Odpowiedz|Udostępnij)(?=\s|$)/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePermalink(value?: string | null): string | null { if (!value) return null; try { const url = new URL(value, "https://www.facebook.com"); if (url.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(url.hostname)) return null; url.search = ""; url.hash = ""; return url.toString(); } catch { return null; } }
function extractPostId(url: string): string | null { return new URL(url).pathname.match(/\/(?:posts|permalink)\/(\d+)/i)?.[1] ?? null; }
function isHttps(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }
function normalizeDate(value?: string | null): string | null { if (!value || Number.isNaN(Date.parse(value))) return null; return new Date(value).toISOString(); }
