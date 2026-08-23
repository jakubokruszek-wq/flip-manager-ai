import { calculateContentHash, normalizeOtodomUrl } from "./otodom-search.ts";
import { extractOlxImages } from "./server/olx-images.ts";
import type { PropertySourceListing } from "../properties/types/property.ts";

export type OlxParseResult = {
  rawItems: number;
  normalizedItems: number;
  listings: PropertySourceListing[];
  warnings: string[];
};

export function assertAllowedOlxUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "olx.pl" && url.hostname !== "www.olx.pl")) {
    throw new Error("OLX_URL_NOT_ALLOWED");
  }
  return url;
}

export function parseOlxHtml(html: string): OlxParseResult {
  const ads = parseOlxAds(html);
  const listings = ads.map(toOlxListing).filter((item): item is PropertySourceListing => item !== null);
  return {
    rawItems: ads.length,
    normalizedItems: listings.length,
    listings,
    warnings: ads.length ? [] : ["OLX zwrócił pustą listę ofert."],
  };
}

export function parseOlxAds(html: string): Record<string, unknown>[] {
  const marker = "window.__PRERENDERED_STATE__";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("OLX: brak PRERENDERED_STATE.");
  const quote = html.indexOf('"', markerIndex + marker.length);
  if (quote < 0) throw new Error("OLX: brak początku PRERENDERED_STATE.");
  let escaped = false;
  let end = -1;
  for (let index = quote + 1; index < html.length; index += 1) {
    const char = html[index];
    if (char === '"' && !escaped) {
      end = index;
      break;
    }
    escaped = char === "\\" && !escaped;
    if (char !== "\\") escaped = false;
  }
  if (end < 0) throw new Error("OLX: niezamknięty PRERENDERED_STATE.");
  let state: unknown;
  try {
    state = JSON.parse(JSON.parse(html.slice(quote, end + 1)) as string) as unknown;
  } catch {
    throw new Error("OLX: niepoprawny JSON PRERENDERED_STATE.");
  }
  const listingState = atPath(state, ["listing"]);
  const listingListingState = atPath(state, ["listing", "listing"]);
  const ads = atPath(state, ["listing", "listing", "ads"]);
  console.info("OLX_PARSER_SHAPE", {
    topLevelKeys: objectKeys(state),
    listingKeys: objectKeys(listingState),
    listingListingKeys: objectKeys(listingListingState),
    adsType: valueType(ads),
    adsLength: Array.isArray(ads) ? ads.length : null,
    nearbyArrayPaths: nearbyArrayPaths([
      { path: "listing", value: listingState },
      { path: "listing.listing", value: listingListingState },
    ]),
  });
  if (!Array.isArray(ads)) throw new Error("OLX_PARSER_SHAPE_CHANGED");
  return ads.filter(isRecord);
}

export function isOlxChallengeHtml(html: string): boolean {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return /just a moment|access denied|verify you are human|human verification|captcha/i.test(title)
    || /__cf_chl_|cf-chl-(?:captcha|managed-challenge)|challenge-platform/i.test(html)
    || /datadome[^<]{0,120}(?:captcha|challenge)|(?:px-captcha|perimeterx)/i.test(html)
    || /<form[^>]+(?:captcha|g-recaptcha|h-captcha)[^>]*>/i.test(html);
}

function toOlxListing(ad: Record<string, unknown>): PropertySourceListing | null {
  const url = absoluteOlxUrl(text(ad, "url"));
  const id = text(ad, "id") ?? idFromUrl(url);
  if (!url || !id) return null;
  const params = Array.isArray(ad.params) ? ad.params.filter(isRecord) : [];
  const param = (key: string) => {
    const found = params.find((item) => text(item, "key") === key);
    return found ? text(found, "normalizedValue", "value") : null;
  };
  const price = numeric(atPath(ad, ["price", "regularPrice", "value"]));
  const area = numeric(param("m"));
  const city = text(isRecord(ad.location) ? ad.location : {}, "cityName");
  const district = text(isRecord(ad.location) ? ad.location : {}, "districtName");
  const images = extractOlxImages(ad.photos);
  const normalizedUrl = normalizeOtodomUrl(url);
  const roomCount = rooms(param("rooms"));
  const locationText = [district, city].filter(Boolean).join(", ") || null;
  const payload = { id, url: normalizedUrl, title: text(ad, "title"), price, area, roomCount, floor: param("floor_select"), city, district };
  return {
    source: "olx",
    externalListingId: id,
    originalUrl: url,
    normalizedUrl,
    title: text(ad, "title"),
    price,
    area,
    rooms: roomCount,
    floor: param("floor_select"),
    pricePerSqm: price !== null && area ? price / area : null,
    city,
    district,
    locationText,
    images,
    thumbnailUrl: images[0] ?? null,
    buildingType: param("builttype"),
    description: text(ad, "description"),
    publishedAt: dateValue(ad.createdTime ?? ad.createdAt ?? ad.created_at ?? ad.publishedAt ?? ad.creation_time),
    rawPayload: ad,
    contentHash: calculateContentHash(payload),
  };
}

function dateValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function absoluteOlxUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return assertAllowedOlxUrl(new URL(value, "https://www.olx.pl").toString()).toString();
  } catch {
    return null;
  }
}

function rooms(value: unknown): number | null {
  const map: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 };
  return numeric(value) ?? (typeof value === "string" ? map[value] ?? null : null);
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/g, "").replace(",", ".")) : null;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function text(value: Record<string, unknown>, ...keys: string[]): string | null {
  const found = keys.map((key) => value[key]).find((item) => typeof item === "string");
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function atPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current;
}

function objectKeys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).slice(0, 20) : [];
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function nearbyArrayPaths(nodes: Array<{ path: string; value: unknown }>): string[] {
  const paths = new Set<string>();
  for (const node of nodes) {
    if (!isRecord(node.value)) continue;
    for (const [key, value] of Object.entries(node.value)) {
      if (Array.isArray(value)) paths.add(`${node.path}.${key}`);
      else if (isRecord(value)) {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          if (Array.isArray(nestedValue)) paths.add(`${node.path}.${key}.${nestedKey}`);
          if (paths.size >= 20) return [...paths];
        }
      }
      if (paths.size >= 20) return [...paths];
    }
  }
  return [...paths];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function idFromUrl(url: string | null): string | null {
  return url?.match(/-ID([^/.]+)|\/([^/?#]+)\/?$/)?.slice(1).find(Boolean) ?? null;
}
