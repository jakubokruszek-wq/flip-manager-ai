/**
 * Stable identity helpers shared by the Facebook Watcher and Flip Finder.
 * The first record wins, so callers must order records newest-first when they
 * want the newest source metadata to be retained.
 */
export type ListingIdentity = {
  listingId: string;
  source: string;
  externalListingId?: string | null;
  sourcePostUrl?: string | null;
};

export function normalizeListingIdentityUrl(source: string, value: string | null | undefined): string | null {
  if (source !== "facebook" || !value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    if (hostname !== "facebook.com" && !hostname.endsWith(".facebook.com")) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/" || pathname.toLocaleLowerCase("en-US").includes("/flip-manager/manual/")) return null;
    return `${url.protocol}//${hostname}${pathname}`;
  } catch {
    return null;
  }
}

export function dedupeByListingIdentity<T>(records: T[], identityOf: (record: T) => ListingIdentity): T[] {
  const seenListingIds = new Set<string>();
  const seenSourcePostUrls = new Set<string>();
  const seenExternalIds = new Set<string>();

  return records.filter((record) => {
    const identity = identityOf(record);
    if (seenListingIds.has(identity.listingId)) return false;
    const sourcePostUrl = normalizeListingIdentityUrl(identity.source, identity.sourcePostUrl);
    const externalKey = identity.externalListingId?.trim()
      ? `${identity.source}:${identity.externalListingId.trim()}`
      : null;
    if (sourcePostUrl && seenSourcePostUrls.has(sourcePostUrl)) return false;
    if (externalKey && seenExternalIds.has(externalKey)) return false;
    seenListingIds.add(identity.listingId);
    if (sourcePostUrl) seenSourcePostUrls.add(sourcePostUrl);
    if (externalKey) seenExternalIds.add(externalKey);
    return true;
  });
}
