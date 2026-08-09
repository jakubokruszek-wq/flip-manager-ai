import "server-only";

import type { ListingSource, SearchFilter } from "@/features/flip-finder";
import { calculateContentHash, normalizeOtodomUrl } from "@/features/flip-finder/otodom-search";
import { searchOtodom } from "@/features/flip-finder/server/otodom-search-adapter";
import { extractOlxImages } from "@/features/flip-finder/server/olx-images";
import type { PropertySourceListing } from "@/features/properties/types/property";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type SourceListing = PropertySourceListing;

export type SourceFetchResult = { listings: SourceListing[]; warnings: string[]; fetched: number };
export type SearchSource = {
  id: Extract<ListingSource, "otodom" | "olx" | "morizon">;
  label: string;
  fetch(criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult>;
};

export const SOURCES: SearchSource[] = [
  { id: "otodom", label: "Otodom", fetch: fetchOtodom },
  { id: "olx", label: "OLX", fetch: fetchOlx },
  { id: "morizon", label: "Morizon", fetch: fetchMorizon },
];

export function activeSources(criteria: SearchFilter): SearchSource[] {
  return SOURCES.filter((source) => criteria.sources.includes(source.id));
}

export function slugifyCity(city: string | null): string {
  return (city ?? "")
    .trim()
    .toLocaleLowerCase("pl-PL")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "polska";
}

async function fetchOtodom(criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult> {
  const result = await searchOtodom(criteria, signal);
  if (isOtodomAdapterContractMismatch(result)) {
    throw new Error("OTODOM_ADAPTER_CONTRACT_MISMATCH: Adapter Otodom znormalizował oferty, ale nie przekazał ich do orkiestratora.");
  }
  return {
    listings: result.listings.map((listing) => ({
      ...listing,
      buildingType: null,
      description: null,
    })),
    warnings: result.warnings,
    fetched: result.listings.length,
  };
}

export function isOtodomAdapterContractMismatch(result: {
  rawItems: number;
  normalizedItems: number;
  listings: ReadonlyArray<unknown>;
}): boolean {
  return result.rawItems > 0 && result.normalizedItems > 0 && result.listings.length === 0;
}

async function fetchOlx(criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult> {
  const html = await fetchHtml(`https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/${slugifyCity(criteria.city)}/`, "OLX", signal);
  const ads = parseOlxAds(html);
  console.info("OLX ITEM SHAPE:", ads.slice(0, 3).map(olxItemShape));
  const normalization = ads.map((ad) => ({ ad, listing: toOlxListing(ad) }));
  const listings = normalization
    .map((item) => item.listing)
    .filter((item): item is SourceListing => item !== null);
  if (process.env.NODE_ENV === "development") {
    listings.forEach((listing) => {
      console.info("OLX IMAGE EXTRACTION:", {
        listingId: listing.externalListingId,
        foundImages: listing.images?.length ?? 0,
        thumbnailUrl: listing.thumbnailUrl,
      });
    });
  }
  const imageExtractionReasons = normalization.reduce<Record<string, number>>(
    (counts, item) => {
      if (!item.listing?.thumbnailUrl) {
        const reason = olxImageExtractionReason(item.ad);
        counts[reason] = (counts[reason] ?? 0) + 1;
      }
      return counts;
    },
    {},
  );
  console.info("OLX NORMALIZATION SUMMARY:", {
    rawItems: ads.length,
    normalizedItems: listings.length,
    listingsWithImages: listings.filter((listing) => Boolean(listing.thumbnailUrl)).length,
    listingsWithoutImages: listings.filter((listing) => !listing.thumbnailUrl).length,
    imageExtractionReasons,
  });
  return { listings, fetched: ads.length, warnings: ads.length ? [] : ["OLX zwrócił pustą listę ofert."] };
}

async function fetchMorizon(criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult> {
  const html = await fetchHtml(`https://www.morizon.pl/mieszkania/${slugifyCity(criteria.city)}/`, "Morizon", signal);
  const offers = parseMorizonOffers(html);
  const listings = offers.map((offer) => toMorizonListing(offer, criteria.city)).filter((item): item is SourceListing => item !== null);
  return { listings, fetched: offers.length, warnings: offers.length ? [] : ["Morizon zwrócił pustą listę ofert."] };
}

async function fetchHtml(url: string, source: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    const headers: Record<string, string> = source === "OLX"
      ? { Accept: ACCEPT, "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.7,en;q=0.6", Referer: "https://www.olx.pl/", "User-Agent": USER_AGENT }
      : { Accept: ACCEPT, "User-Agent": USER_AGENT };
    response = await fetch(url, { cache: "no-store", headers, redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch (error) {
    throw new Error(`${source}: błąd połączenia (${error instanceof Error ? error.name : "unknown"}).`);
  }
  if (source === "OLX" && process.env.NODE_ENV === "development") {
    console.info("OLX REQUEST", JSON.stringify({ url, status: response.status, contentType: response.headers.get("content-type"), redirected: response.redirected, finalUrl: response.url }));
  }
  const html = await response.text();
  console.info("FLIP FINDER SOURCE RESPONSE:", { source, url, status: response.status, contentType: response.headers.get("content-type"), finalUrl: response.url, bodyLength: html.length });
  if (response.status === 403 || response.status === 429) throw new Error(`${source}: HTTP ${response.status}.`);
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}.`);
  if (isStrongChallengeHtml(html)) throw new Error(`${source}: challenge HTML.`);
  return html;
}

function parseOlxAds(html: string): Record<string, unknown>[] {
  const marker = "window.__PRERENDERED_STATE__";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error("OLX: brak PRERENDERED_STATE.");
  const quote = html.indexOf('"', markerIndex + marker.length);
  if (quote < 0) throw new Error("OLX: brak początku PRERENDERED_STATE.");
  let escaped = false; let end = -1;
  for (let index = quote + 1; index < html.length; index += 1) { const char = html[index]; if (char === '"' && !escaped) { end = index; break; } escaped = char === "\\" && !escaped; if (char !== "\\") escaped = false; }
  if (end < 0) throw new Error("OLX: niezamknięty PRERENDERED_STATE.");
  let state: unknown;
  try { state = JSON.parse(JSON.parse(html.slice(quote, end + 1)) as string) as unknown; } catch { throw new Error("OLX: niepoprawny JSON PRERENDERED_STATE."); }
  const ads = atPath(state, ["listing", "listing", "ads"]);
  return Array.isArray(ads) ? ads.filter(isRecord) : [];
}

function toOlxListing(ad: Record<string, unknown>): SourceListing | null {
  const url = absoluteUrl(text(ad, "url"), "https://www.olx.pl", "olx.pl"); const id = text(ad, "id") ?? idFromUrl(url);
  if (!url || !id) return null;
  const params = Array.isArray(ad.params) ? ad.params.filter(isRecord) : [];
  const param = (key: string) => { const found = params.find((item) => text(item, "key") === key); return found ? text(found, "normalizedValue", "value") : null; };
  const price = number(atPath(ad, ["price", "regularPrice", "value"])); const area = number(param("m"));
  return listing("olx", id, url, text(ad, "title"), price, area, rooms(param("rooms")), param("floor_select"), text(atPath(ad, ["location"]) as Record<string, unknown> ?? {}, "cityName"), text(atPath(ad, ["location"]) as Record<string, unknown> ?? {}, "districtName"), text(ad, "description"), extractOlxImages(ad.photos), param("builttype"), ad);
}

function olxItemShape(ad: Record<string, unknown>) {
  const photosValue = ad.photos;
  const imagesValue = ad.images;
  const firstPhoto = Array.isArray(photosValue) ? photosValue[0] : null;
  const firstImage = Array.isArray(imagesValue) ? imagesValue[0] : null;
  const nestedFields = Object.fromEntries(
    ["photos", "photo", "images", "image", "gallery", "media", "pictures", "promotion", "params"].map(
      (key) => [key, olxFieldShape(ad[key])],
    ),
  );

  return {
    itemKeys: Object.keys(ad),
    hasPhotos: Object.prototype.hasOwnProperty.call(ad, "photos"),
    photosType: olxValueType(photosValue),
    photosIsArray: Array.isArray(photosValue),
    photosCount: Array.isArray(photosValue) ? photosValue.length : null,
    firstPhotoType: olxValueType(firstPhoto),
    firstPhotoKeys: isRecord(firstPhoto) ? Object.keys(firstPhoto) : [],
    hasPhoto: Object.prototype.hasOwnProperty.call(ad, "photo"),
    photoType: olxValueType(ad.photo),
    hasImages: Object.prototype.hasOwnProperty.call(ad, "images"),
    imagesType: olxValueType(imagesValue),
    imagesIsArray: Array.isArray(imagesValue),
    imagesCount: Array.isArray(imagesValue) ? imagesValue.length : null,
    firstImageType: olxValueType(firstImage),
    firstImageKeys: isRecord(firstImage) ? Object.keys(firstImage) : [],
    photoRelatedTopLevelKeys: Object.keys(ad).filter((key) =>
      /(photo|image|picture|gallery|media)/i.test(key),
    ),
    nestedFields,
  };
}

function olxFieldShape(value: unknown) {
  const first = Array.isArray(value) ? value[0] : value;

  return {
    type: olxValueType(value),
    isArray: Array.isArray(value),
    count: Array.isArray(value) ? value.length : null,
    firstItemType: olxValueType(first),
    firstItemKeys: isRecord(first) ? Object.keys(first) : [],
  };
}

function olxValueType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  return Array.isArray(value) ? "array" : typeof value;
}

function olxImageExtractionReason(ad: Record<string, unknown>): string {
  const imageFields = ["photos", "photo", "images", "image", "gallery", "media", "pictures"];
  const presentValues = imageFields
    .filter((key) => Object.prototype.hasOwnProperty.call(ad, key))
    .map((key) => ad[key]);

  if (presentValues.length === 0) {
    return "photo_field_missing";
  }

  if (presentValues.some((value) => Array.isArray(value) && value.length === 0)) {
    return "photo_array_empty";
  }

  return "unsupported_photo_shape";
}

function parseMorizonOffers(html: string): Record<string, unknown>[] {
  const blocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]; const offers: Record<string, unknown>[] = [];
  for (const block of blocks) { try { collectOffers(JSON.parse(block[1]) as unknown, offers); } catch { continue; } }
  if (!blocks.length) throw new Error("Morizon: brak bloków JSON-LD.");
  return offers;
}

function collectOffers(value: unknown, output: Record<string, unknown>[]): void {
  if (Array.isArray(value)) { value.forEach((item) => collectOffers(item, output)); return; }
  if (!isRecord(value)) return;
  const nested = atPath(value, ["offers", "offers"]); if (Array.isArray(nested)) nested.filter(isRecord).forEach((item) => output.push(item));
  if (text(value, "@type") === "Product" || text(value, "@type") === "Offer" || "price" in value) output.push(value);
  const graph = value["@graph"]; if (Array.isArray(graph)) graph.forEach((item) => collectOffers(item, output));
  const items = value.itemListElement; if (Array.isArray(items)) items.forEach((item) => collectOffers(isRecord(item) && isRecord(item.item) ? item.item : item, output));
}

function toMorizonListing(offer: Record<string, unknown>, fallbackCity: string | null): SourceListing | null {
  const url = absoluteUrl(text(offer, "url"), "https://www.morizon.pl", "morizon.pl"); if (!url) return null;
  const item = isRecord(offer.itemOffered) ? offer.itemOffered : offer; const address = isRecord(item.address) ? item.address : {};
  const price = number(offer.price); const area = number(atPath(item, ["floorSize", "value"]));
  if (price === null || price <= 0 || area === null || area <= 0 || /\/mieszkania\/[^/]+\/?$/i.test(new URL(url).pathname)) return null;
  const locality = text(address, "addressLocality"); const district = locality && ["bałuty", "górna", "polesie", "śródmieście", "widzew"].includes(normalize(locality)) ? locality : null;
  return listing("morizon", idFromUrl(url) ?? hash(url), url, text(offer, "name"), price, area, number(item.numberOfRooms), text(item, "floorLevel"), district ? fallbackCity : locality ?? fallbackCity, district, text(item, "description"), imageValues(offer.image), null, offer);
}

function listing(source: SourceListing["source"], id: string, url: string, title: string | null, price: number | null, area: number | null, roomCount: number | null, floor: string | null, city: string | null, district: string | null, description: string | null, images: string[], buildingType: string | null, rawPayload: Record<string, unknown>): SourceListing {
  const locationText = [district, city].filter(Boolean).join(", ") || null; const normalizedUrl = normalizeOtodomUrl(url);
  const payload = { id, url: normalizedUrl, title, price, area, roomCount, floor, city, district };
  return { source, externalListingId: id, originalUrl: url, normalizedUrl, title, price, area, rooms: roomCount, floor, pricePerSqm: price !== null && area ? price / area : null, city, district, locationText, images, thumbnailUrl: images[0] ?? null, buildingType, description, rawPayload, contentHash: calculateContentHash(payload) };
}

function absoluteUrl(value: string | null, base: string, host: string): string | null { if (!value) return null; try { const url = new URL(value, base); return url.hostname === host || url.hostname.endsWith(`.${host}`) ? url.toString() : null; } catch { return null; } }
function imageValues(value: unknown): string[] { return (Array.isArray(value) ? value : [value]).filter((item): item is string => Boolean(item)).slice(0, 10); }
function rooms(value: unknown): number | null { const map: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5, SIX: 6 }; return number(value) ?? (typeof value === "string" ? map[value] ?? null : null); }
function number(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/g, "").replace(",", ".")) : null; return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null; }
function text(value: Record<string, unknown>, ...keys: string[]): string | null { const found = keys.map((key) => value[key]).find((item) => typeof item === "string"); return typeof found === "string" && found.trim() ? found.trim() : null; }
function atPath(value: unknown, path: string[]): unknown { let current: unknown = value; for (const key of path) { if (!isRecord(current)) return null; current = current[key]; } return current; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function idFromUrl(url: string | null): string | null { return url?.match(/-ID([^/.]+)|\/([^/?#]+)\/?$/)?.slice(1).find(Boolean) ?? null; }
function hash(value: string): string { let result = 5381; for (const char of value) result = (result * 33) ^ char.charCodeAt(0); return (result >>> 0).toString(16); }
function normalize(value: string): string { return value.toLocaleLowerCase("pl-PL").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l"); }

function isStrongChallengeHtml(html: string): boolean {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  return /just a moment|access denied|verify you are human/i.test(title) || /__cf_chl_|cf-chl-(?:captcha|managed-challenge)|challenge-platform/i.test(html) || /datadome[^<]{0,120}(?:captcha|challenge)|(?:px-captcha|perimeterx)/i.test(html) || /<form[^>]+(?:captcha|g-recaptcha|h-captcha)[^>]*>/i.test(html);
}
