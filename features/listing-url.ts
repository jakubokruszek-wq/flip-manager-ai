/**
 * Resolve the URL that may be exposed to a user for a persisted listing.
 *
 * Facebook keeps the authoritative post URL in listing_source_metadata. A
 * listing row can be older than that metadata (or contain a manual-import
 * placeholder), so callers must use this resolver instead of rendering a
 * database value directly into an anchor.
 */
export type ListingUrlInput = {
  source: string | null | undefined;
  sourcePostUrl?: string | null;
  originalUrl?: string | null;
};

export function resolveListingUrl(input: ListingUrlInput): string | null {
  const source = input.source?.trim().toLowerCase();
  const candidates = source === "facebook"
    ? [input.sourcePostUrl, input.originalUrl]
    : [input.originalUrl];

  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (!value || isManualPlaceholder(value)) continue;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (source === "facebook" && isFacebookLandingPage(url)) continue;
    return value;
  }

  return null;
}

function isManualPlaceholder(value: string): boolean {
  return /^manual:/i.test(value) || /(?:^|\/)flip-manager\/manual(?:\/|$)/i.test(value);
}

function isFacebookLandingPage(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "facebook.com" && hostname !== "fb.com") return false;

  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (!path || path === "/home" || path === "/home.php") return true;

  // Group/marketplace roots are useful navigation pages, but do not identify
  // one concrete offer. Concrete post/item URLs and permalink query URLs pass
  // through the resolver.
  if (path === "/groups" || (path.startsWith("/groups/") && !/(?:\/posts\/|\/permalink(?:\.php|\/)|\/videos\/|\/reels?\/|\/photos?\/)/.test(path) && !url.searchParams.has("story_fbid"))) return true;
  if (path === "/marketplace" || path === "/marketplace/category") return true;

  return false;
}
