import { createHash } from "node:crypto";

/**
 * Stable identity helpers shared by the Facebook Collector, Watcher and
 * Finder. The first record in each identity tier wins, so callers must order
 * records by their preferred winner before calling dedupeByListingIdentity().
 */
export type ListingIdentity = {
  listingId: string;
  source: string;
  externalListingId?: string | null;
  sourcePostUrl?: string | null;
  originalUrl?: string | null;
  facebookPostId?: string | null;
  /** Stable property parameters, deliberately independent of image URLs. */
  parameterFingerprint?: string | null;
  contentFingerprint?: string | null;
};

export function normalizeListingIdentityUrl(source: string, value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedSource = source.toLocaleLowerCase("en-US");
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^(?:www|m)\./, "");
    const isFacebook = normalizedSource === "facebook";
    if (isFacebook && hostname !== "facebook.com" && !hostname.endsWith(".facebook.com")) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/" || isFacebook && pathname.toLocaleLowerCase("en-US").includes("/flip-manager/manual/")) return null;
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_/iu.test(key) && !["ref", "mibextid", "__tn__", "locale", "fbclid", "gclid", "dclid", "msclkid", "yclid"].includes(key.toLocaleLowerCase("en-US")))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    return `${url.protocol}//${hostname}${pathname}${query ? `?${query}` : ""}`;
  } catch {
    return null;
  }
}

export type CanonicalFacebookIdentity = {
  postId: string | null;
  sourcePostUrl: string | null;
  externalListingId: string | null;
  parameterFingerprint: string | null;
  contentFingerprint: string | null;
  keys: string[];
};

/**
 * Resolves every stable Facebook identity we can prove. A post ID is the
 * strongest key, followed by the normalized source URL and external ID. The
 * Parameter identity is optional and is only a conservative fallback for
 * Facebook reposts. The full-content fingerprint remains the last fallback;
 * it is based on the full listing content and never only title, price and
 * area.
 */
export function canonicalFacebookIdentity(input: Omit<ListingIdentity, "listingId" | "source"> & { source?: string | null }): CanonicalFacebookIdentity {
  const source = input.source ?? "facebook";
  if (source !== "facebook") return { postId: null, sourcePostUrl: null, externalListingId: null, parameterFingerprint: null, contentFingerprint: null, keys: [] };

  const sourcePostUrl = normalizeListingIdentityUrl("facebook", input.sourcePostUrl)
    ?? normalizeListingIdentityUrl("facebook", input.originalUrl);
  const postId = normalizeFacebookPostId(input.facebookPostId)
    ?? extractFacebookPostId(input.sourcePostUrl)
    ?? extractFacebookPostId(input.originalUrl)
    ?? extractFacebookPostId(input.externalListingId);
  const externalListingId = normalizeIdentityPart(input.externalListingId);
  const parameterFingerprint = normalizeIdentityPart(input.parameterFingerprint);
  const contentFingerprint = normalizeIdentityPart(input.contentFingerprint);
  const keys = [
    postId ? `facebook:post:${postId}` : null,
    sourcePostUrl ? `facebook:url:${sourcePostUrl}` : null,
    externalListingId ? `facebook:external:${externalListingId}` : null,
    parameterFingerprint ? `facebook:parameters:${parameterFingerprint}` : null,
    contentFingerprint ? `facebook:fingerprint:${contentFingerprint}` : null,
  ].filter((key): key is string => Boolean(key));
  return { postId, sourcePostUrl, externalListingId, parameterFingerprint, contentFingerprint, keys };
}

/**
 * Computes a conservative property-level identity for Facebook reposts.
 *
 * This intentionally needs a title, total price, area and a location. It is
 * therefore stronger than a title/price/area-only comparison, while ignoring
 * image URLs that may be missing on one scan or replaced after gallery
 * hydration. Callers should only provide a location when it contains a
 * property-level component (street, neighbourhood or district), not just a
 * city. A post ID or URL always wins when available.
 */
export function canonicalFacebookParameterFingerprint(input: {
  title?: string | null;
  description?: string | null;
  price?: number | null;
  area?: number | null;
  rooms?: number | null;
  location?: string | null;
}): string | null {
  const title = normalizeFingerprintText(input.title);
  const description = normalizeFingerprintText(input.description);
  const location = normalizeFingerprintText(input.location);
  const price = finiteNumber(input.price);
  const area = finiteNumber(input.area);
  if (!title || !location || price === null || area === null) return null;
  return createHash("sha256").update(JSON.stringify({ title, description, price, area, rooms: finiteNumber(input.rooms), location })).digest("hex");
}

export function canonicalFacebookContentFingerprint(input: {
  title?: string | null;
  description?: string | null;
  price?: number | null;
  area?: number | null;
  rooms?: number | null;
  location?: string | null;
  imageUrls?: string[] | null;
}): string {
  const stable = {
    title: normalizeFingerprintText(input.title),
    description: normalizeFingerprintText(input.description),
    price: finiteNumber(input.price),
    area: finiteNumber(input.area),
    rooms: finiteNumber(input.rooms),
    location: normalizeFingerprintText(input.location),
    imageUrls: [...new Set((input.imageUrls ?? []).filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))].sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function extractFacebookPostId(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  const direct = normalizeFacebookPostId(text);
  if (direct) return direct;
  const prefixed = /^(?:facebook:(?:group:[^:]+:post|story:[^:]+)|facebook:post):([0-9]{5,30})$/iu.exec(text);
  if (prefixed) return prefixed[1];
  try {
    const url = new URL(text);
    const queryId = url.searchParams.get("story_fbid") ?? url.searchParams.get("fbid") ?? url.searchParams.get("video_id");
    if (normalizeFacebookPostId(queryId)) return normalizeFacebookPostId(queryId);
    const match = /\/(?:posts|permalink|videos|reel|photo|photos)\/([0-9]{5,30})(?:\/|$)/iu.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeFacebookPostId(value: string | null | undefined): string | null {
  return value && /^[0-9]{5,30}$/.test(value.trim()) ? value.trim() : null;
}

function normalizeIdentityPart(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeFingerprintText(value: string | null | undefined): string | null {
  const normalized = value?.normalize("NFKC").replace(/[*_~`#]/gu, "").replace(/\s+/gu, " ").trim().toLocaleLowerCase("pl-PL");
  return normalized || null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function dedupeByListingIdentity<T>(records: T[], identityOf: (record: T) => ListingIdentity): T[] {
  const seenListingIds = new Set<string>();
  /**
   * Keep the post id which owns every canonical key. A content/parameter key
   * is a weak fallback: it may merge two records only while neither record
   * proves a different Facebook post. Once two confirmed post ids differ,
   * that weak key must not hide either real post.
   */
  const seenCanonicalKeys = new Map<string, string | null>();

  // Confirmed post identities are processed first so an unconfirmed legacy
  // row can never occupy a weak fingerprint slot and hide a later real post.
  // Within each tier the caller's preferred ordering remains authoritative.
  const ordered = records.map((record) => {
    const identity = identityOf(record);
    return { record, identity, canonical: canonicalFacebookIdentity(identity) };
  }).sort((left, right) => Number(right.canonical.postId !== null) - Number(left.canonical.postId !== null));

  return ordered.filter(({ identity, canonical }) => {
    if (seenListingIds.has(identity.listingId)) return false;
    const keys = identity.source === "facebook"
      ? canonical.keys
      : [
        identity.externalListingId?.trim() ? `${identity.source}:${identity.externalListingId.trim()}` : null,
        normalizeListingIdentityUrl(identity.source, identity.originalUrl) ? `${identity.source}:url:${normalizeListingIdentityUrl(identity.source, identity.originalUrl)}` : null,
        normalizeListingIdentityUrl(identity.source, identity.sourcePostUrl) ? `${identity.source}:url:${normalizeListingIdentityUrl(identity.source, identity.sourcePostUrl)}` : null,
      ].filter((key): key is string => Boolean(key));
    // Parameter identity is a last-resort key only. If either record has a
    // stronger Facebook identity (post id, URL, external id or full content),
    // do not collapse it merely because a second post has the same visible
    // parameters. This keeps genuinely different posts separate while still
    // collapsing parameter-only legacy rows.
    const strongKeys = identity.source === "facebook" ? keys.filter((key) => !key.startsWith("facebook:parameters:")) : keys;
    const parameterKeys = identity.source === "facebook" ? keys.filter((key) => key.startsWith("facebook:parameters:")) : [];
    const currentPostId = identity.source === "facebook" ? canonical.postId : null;
    const conflictsWithDifferentPost = (key: string) => {
      const ownerPostId = seenCanonicalKeys.get(key);
      return ownerPostId !== undefined && ownerPostId !== null && currentPostId !== null && ownerPostId !== currentPostId;
    };
    const duplicateOfSamePost = (key: string) => {
      const ownerPostId = seenCanonicalKeys.get(key);
      return ownerPostId !== undefined && (ownerPostId === null || currentPostId === null || ownerPostId === currentPostId);
    };
    // A shared content/external/URL key cannot collapse two confirmed post
    // ids. A same-post key still deduplicates duplicate listings normally.
    if (strongKeys.some((key) => !conflictsWithDifferentPost(key) && duplicateOfSamePost(key))) return false;
    if (strongKeys.length === 0 && parameterKeys.some((key) => !conflictsWithDifferentPost(key) && duplicateOfSamePost(key))) return false;
    seenListingIds.add(identity.listingId);
    for (const key of strongKeys) {
      if (!seenCanonicalKeys.has(key) || currentPostId !== null) seenCanonicalKeys.set(key, currentPostId);
    }
    if (strongKeys.length === 0) for (const key of parameterKeys) {
      if (!seenCanonicalKeys.has(key) || currentPostId !== null) seenCanonicalKeys.set(key, currentPostId);
    }
    return true;
  }).map(({ record }) => record);
}
