/**
 * Accept only canonical Facebook group post URLs that carry an explicit post
 * id. Both URL shapes are emitted by Facebook for the same root story.
 */
export function safeFacebookPostUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const validHost = /(^|\.)facebook\.com$/i.test(url.hostname);
    const validPath = /\/groups\/[^/]+\/(?:permalink|posts)\/\d{5,30}(?:\/|$)/i.test(url.pathname);
    return url.protocol === "https:" && validHost && validPath ? url.toString() : null;
  } catch {
    return null;
  }
}
