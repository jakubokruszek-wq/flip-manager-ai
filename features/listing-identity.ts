import { createHash } from "node:crypto";

/**
 * Stable identity helpers shared by the Facebook Collector, Watcher and
 * Finder. The first record wins, so callers must order records by their
 * preferred winner before calling dedupeByListingIdentity().
 */
export type ListingIdentity = {
  listingId: string;
  source: string;
  externalListingId?: string | null;
  sourcePostUrl?: string | null;
  originalUrl?: string | null;
  facebookPostId?: string | null;
  contentFingerprint?: string | null;
};

export function normalizeListingIdentityUrl(source: string, value: string | null | undefined): string | null {
  if (source !== "facebook" || !value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^(?:www|m)\./, "");
    const isFacebook = source.toLocaleLowerCase("en-US") === "facebook";
    if (isFacebook && hostname !== "facebook.com" && !hostname.endsWith(".facebook.com")) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "/" || isFacebook && pathname.toLocaleLowerCase("en-US").includes("/flip-manager/manual/")) return null;
    const query = [...url.searchParams.entries()]
      .filter(([key]) => !/^utm_/iu.test(key) && !["ref", "mibextid", "__tn__", "locale"].includes(key.toLocaleLowerCase("en-US")))
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
  contentFingerprint: string | null;
  keys: string[];
};

/**
 * Resolves every stable Facebook identity we can prove. A post ID is the
 * strongest key, followed by the normalized source URL and external ID. The
 * fingerprint is deliberately last: it is based on the full listing content,
 * never only title, price and area, and is used to collapse identical
 * cross-posted payloads while keeping merely similar offers separate.
 */
export function canonicalFacebookIdentity(input: Omit<ListingIdentity, "listingId" | "source"> & { source?: string | null }): CanonicalFacebookIdentity {
  const source = input.source ?? "facebook";
  if (source !== "facebook") return { postId: null, sourcePostUrl: null, externalListingId: null, contentFingerprint: null, keys: [] };

  const sourcePostUrl = normalizeListingIdentityUrl("facebook", input.sourcePostUrl ?? input.originalUrl);
  const postId = normalizeFacebookPostId(input.facebookPostId)
    ?? extractFacebookPostId(input.sourcePostUrl)
    ?? extractFacebookPostId(input.originalUrl)
    ?? extractFacebookPostId(input.externalListingId);
  const externalListingId = normalizeIdentityPart(input.externalListingId);
  const contentFingerprint = normalizeIdentityPart(input.contentFingerprint);
  const keys = [
    postId ? `facebook:post:${postId}` : null,
    sourcePostUrl ? `facebook:url:${sourcePostUrl}` : null,
    externalListingId ? `facebook:external:${externalListingId}` : null,
    contentFingerprint ? `facebook:fingerprint:${contentFingerprint}` : null,
  ].filter((key): key is string => Boolean(key));
  return { postId, sourcePostUrl, externalListingId, contentFingerprint, keys };
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
  const seenCanonicalKeys = new Set<string>();

  return records.filter((record) => {
    const identity = identityOf(record);
    if (seenListingIds.has(identity.listingId)) return false;
    const canonical = canonicalFacebookIdentity(identity);
    const keys = identity.source === "facebook"
      ? canonical.keys
      : [identity.externalListingId?.trim() ? `${identity.source}:${identity.externalListingId.trim()}` : null, normalizeListingIdentityUrl(identity.source, identity.sourcePostUrl)].filter((key): key is string => Boolean(key));
    if (keys.some((key) => seenCanonicalKeys.has(key))) return false;
    seenListingIds.add(identity.listingId);
    for (const key of keys) seenCanonicalKeys.add(key);
    return true;
  });
}
