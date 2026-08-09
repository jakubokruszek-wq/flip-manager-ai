import "server-only";

import type { SearchFilter } from "@/features/flip-finder";
import {
  classifyOtodomFetchError,
  inspectOtodomSearchResponse,
  otodomSearchErrorMessage,
  safeOtodomResponsePreview,
  type OtodomSearchFailureKind,
} from "@/features/flip-finder/otodom-search-response";
import {
  buildSearchUrl,
  calculateContentHash,
  extractOtodomListingId,
  normalizeOtodomUrl,
} from "@/features/flip-finder/otodom-search";
import type { PropertySearchListing } from "@/features/properties/types/property";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_LISTINGS = 30;
const OTODOM_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const OTODOM_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

export type OtodomSearchResponse = {
  listings: PropertySearchListing[];
  rawItems: number;
  normalizedItems: number;
  warnings: string[];
};

type SearchAdsItemsResult =
  | { kind: "items"; items: Record<string, unknown>[] }
  | { kind: "missing_search_ads" };

export class OtodomSearchError extends Error {
  readonly kind: OtodomSearchFailureKind;
  readonly status: number;

  constructor(kind: OtodomSearchFailureKind) {
    super(otodomSearchErrorMessage(kind));
    this.name = "OtodomSearchError";
    this.kind = kind;
    this.status = kind === "timeout" ? 504 : 502;
  }
}

export async function searchOtodom(filter: SearchFilter, signal?: AbortSignal): Promise<OtodomSearchResponse> {
  const requestedUrl = buildSearchUrl(filter);
  const startedAt = performance.now();
  let response: Response;

  try {
    response = await fetch(requestedUrl, {
      cache: "no-store",
      headers: {
        Accept: OTODOM_ACCEPT,
        "Accept-Language": "pl-PL,pl;q=0.9",
        "User-Agent": OTODOM_USER_AGENT,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const kind = classifyOtodomFetchError(error);
    console.warn("OTODOM SEARCH NETWORK ERROR:", {
      requestedUrl,
      elapsedMs: Math.round(performance.now() - startedAt),
      kind,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: errorCode(error),
    });
    throw new OtodomSearchError(kind);
  }

  let body: string;

  try {
    body = await response.text();
  } catch (error) {
    const kind = classifyOtodomFetchError(error);
    console.warn("OTODOM SEARCH BODY ERROR:", {
      requestedUrl,
      finalUrl: response.url,
      status: response.status,
      elapsedMs: Math.round(performance.now() - startedAt),
      kind,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: errorCode(error),
    });
    throw new OtodomSearchError(kind);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const failure = inspectOtodomSearchResponse({
    status: response.status,
    contentType,
    finalUrl: response.url,
    body,
  });

  console.info("OTODOM SEARCH RESPONSE:", {
    requestedUrl,
    finalUrl: response.url,
    status: response.status,
    contentType,
    bodyLength: body.length,
    elapsedMs: Math.round(performance.now() - startedAt),
    preview: safeOtodomResponsePreview(body),
    classification: failure ?? "recognized",
  });

  console.info("OTODOM SEARCH STRUCTURE:", otodomStructureDiagnostics(body));

  if (failure) {
    throw new OtodomSearchError(failure);
  }

  const searchAds = readSearchAdsItems(body);

  console.info("OTODOM SEARCH DATA:", {
    requestedUrl,
    nextData: true,
    searchAds: searchAds.kind === "items" ? "present" : "missing",
    searchAdsItemsCount: searchAds.kind === "items" ? searchAds.items.length : null,
  });

  if (searchAds.kind === "missing_search_ads") {
    throw new OtodomSearchError("changed_structure");
  }

  console.info("OTODOM ITEM SHAPE:", searchAds.items.slice(0, 3).map(itemShape));
  const normalization = searchAds.items.map((item) => ({ listing: toListing(item), reason: normalizationReason(item) }));
  const rejectionReasons = normalization.reduce<Record<string, number>>((counts, item) => {
    if (item.listing === null) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
    return counts;
  }, {});
  const normalized = normalization
    .map((item) => item.listing)
    .filter((item): item is PropertySearchListing => item !== null);
  console.info("OTODOM NORMALIZATION SUMMARY:", { rawItems: searchAds.items.length, normalizedItems: normalized.length, rejectedItems: searchAds.items.length - normalized.length, rejectionReasons });
  if (searchAds.items.length > 0 && normalized.length === 0) {
    throw new Error(`Otodom zwrócił ${searchAds.items.length} ofert, ale żadnej nie udało się znormalizować. Struktura pojedynczej oferty prawdopodobnie się zmieniła.`);
  }
  const listings = normalized.slice(0, MAX_LISTINGS);
  const warnings: string[] = [];

  if (searchAds.items.length === 0) {
    warnings.push("Otodom zwrócił pustą pierwszą stronę wyników dla tego filtra.");
  } else if (listings.length === 0) {
    warnings.push("Żadna oferta z pierwszej strony nie spełniła lokalnych warunków filtra.");
  }

  if (filter.districts.length) {
    warnings.push("Dzielnice nie są jeszcze niezawodnie mapowane do parametrów Otodom.");
  }

  console.info("OTODOM ADAPTER RETURN:", {
    returnedItems: listings.length,
    firstExternalIdPresent: Boolean(listings[0]?.externalListingId),
    firstSourceUrlPresent: Boolean(listings[0]?.originalUrl),
  });
  return { listings, rawItems: searchAds.items.length, normalizedItems: normalized.length, warnings };
}

function itemShape(item: Record<string, unknown>) {
  return { itemKeys: Object.keys(item), idType: typeof item.id, hasSlug: "slug" in item, hasUrl: "url" in item, totalPriceType: typeof item.totalPrice, priceType: typeof item.price, areaInSquareMetersType: typeof item.areaInSquareMeters, areaType: typeof item.area, roomsNumberType: typeof item.roomsNumber, floorNumberType: typeof item.floorNumber, locationKeys: isRecord(item.location) ? Object.keys(item.location) : [], imageKeys: Array.isArray(item.images) && isRecord(item.images[0]) ? Object.keys(item.images[0]) : [], totalPriceKeys: isRecord(item.totalPrice) ? Object.keys(item.totalPrice) : [], priceKeys: isRecord(item.price) ? Object.keys(item.price) : [], propertiesKeys: isRecord(item.properties) ? Object.keys(item.properties) : [], estateKeys: isRecord(item.estate) ? Object.keys(item.estate) : [] };
}

function normalizationReason(item: Record<string, unknown>): string {
  if (!listingUrl(item)) return text(item, "slug") ? "missing_external_id" : "missing_url_or_slug";
  if (!text(item, "id", "adId", "listingId") && !extractOtodomListingId(listingUrl(item) ?? "")) return "missing_external_id";
  return "mapper_exception";
}

function readSearchAdsItems(html: string): SearchAdsItemsResult {
  const nextDataMatch = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );

  if (!nextDataMatch) {
    throw new OtodomSearchError("changed_structure");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(nextDataMatch[1]) as unknown;
  } catch {
    throw new OtodomSearchError("changed_structure");
  }

  const props = recordValue(payload, "props");
  const pageProps = props ? recordValue(props, "pageProps") : null;
  const data = pageProps ? recordValue(pageProps, "data") : null;
  const searchAds = data ? recordValue(data, "searchAds") : null;

  if (!searchAds) {
    return { kind: "missing_search_ads" };
  }

  const items = Array.isArray(searchAds.items)
    ? searchAds.items.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];

  return { kind: "items", items };
}

function toListing(row: Record<string, unknown>): PropertySearchListing | null {
  const originalUrl = listingUrl(row);

  if (!originalUrl) {
    return null;
  }

  const normalizedUrl = normalizeOtodomUrl(originalUrl);
  const externalListingId =
    text(row, "id", "adId", "listingId") ?? extractOtodomListingId(normalizedUrl);

  if (!externalListingId) {
    return null;
  }

  const price = numberValue(row.totalPrice ?? row.price);
  const area = numberValue(row.areaInSquareMeters ?? row.area);
  const pricePerSqm =
    numberValue(row.pricePerSquareMeter ?? row.pricePerSqm) ??
    (price !== null && area ? price / area : null);
  const city = locationName(row, "city_or_village") ?? locationName(row, "city");
  const district = locationName(row, "district");
  const address = locationName(row, "address") ?? text(row, "locationLabel", "address");
  const title = text(row, "title", "name");
  const rooms = mapRoomsNumber(row.roomsNumber ?? row.rooms);
  const floor = mapFloorNumber(row.floorNumber ?? row.floor);
  const rawPayload = {
    id: externalListingId,
    url: normalizedUrl,
    title,
    price,
    area,
    rooms,
    floor,
    locationText: address,
  };

  return {
    source: "otodom",
    externalListingId,
    originalUrl: normalizedUrl,
    normalizedUrl,
    title,
    price,
    area,
    rooms,
    floor,
    pricePerSqm,
    locationText: address,
    city,
    district,
    thumbnailUrl: thumbnailUrl(row),
    sellerType: text(row, "sellerType", "advertiserType"),
    marketType: text(row, "marketType"),
    publishedAt: text(row, "createdAt", "publishedAt"),
    rawPayload,
    contentHash: calculateContentHash(rawPayload),
  };
}

function listingUrl(row: Record<string, unknown>): string | null {
  const directUrl = text(row, "url", "href", "link");

  if (directUrl) {
    return new URL(directUrl, "https://www.otodom.pl").toString();
  }

  const id = text(row, "id", "adId", "listingId");
  const slug = text(row, "slug");
  return id && slug ? `https://www.otodom.pl/pl/oferta/${slug}-ID${id}` : null;
}

function thumbnailUrl(row: Record<string, unknown>): string | null {
  const directImage = text(row, "image", "thumbnail", "imageUrl");

  if (directImage) {
    return directImage;
  }

  if (!Array.isArray(row.images)) {
    return null;
  }

  const firstImage = row.images.find((image): image is Record<string, unknown> => isRecord(image));
  return firstImage ? text(firstImage, "large", "medium", "small", "thumbnail", "url") : null;
}

function locationName(row: Record<string, unknown>, level: string): string | null {
  const location = recordValue(row, "location");

  if (!location) {
    return null;
  }

  const reverseGeocoding = recordValue(location, "reverseGeocoding");
  const locations = reverseGeocoding && Array.isArray(reverseGeocoding.locations)
    ? reverseGeocoding.locations.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  const match = locations.find((item) => text(item, "locationLevel") === level);

  if (match) {
    return text(match, "name");
  }

  if (level === "address") {
    const address = recordValue(location, "address");
    return address ? text(address, "street", "displayName") : null;
  }

  return text(location, level, `${level}Name`);
}

function mapRoomsNumber(value: unknown): number | null {
  const numeric = numberValue(value);

  if (numeric !== null) {
    return numeric;
  }

  const enumValue = typeof value === "string" ? value.toUpperCase() : "";
  const entry = Object.entries({
    ONE: 1,
    TWO: 2,
    THREE: 3,
    FOUR: 4,
    FIVE: 5,
    SIX_OR_MORE: 6,
  }).find(([key]) => key === enumValue);

  return entry ? entry[1] : null;
}

function mapFloorNumber(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  if (value === "GROUND_FLOOR" || value === "ground_floor") {
    return "parter";
  }

  return value.replace(/^FLOOR_|^floor_/, "").replaceAll("_", " ");
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (isRecord(value) && "value" in value) {
    return numberValue(value.value);
  }

  return null;
}

function text(row: Record<string, unknown>, ...keys: string[]): string | null {
  const value = keys.map((key) => row[key]).find((item) => typeof item === "string");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown, key: string): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value[key]) ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const value = error as { code?: unknown; cause?: { code?: unknown } };
  const code = value.cause?.code ?? value.code;
  return typeof code === "string" ? code : null;
}

function otodomStructureDiagnostics(html: string) {
  const nextDataMatch = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  const payload = nextDataMatch ? safelyParse(nextDataMatch[1]) : null;
  const props = recordValue(payload, "props");
  const pageProps = props ? recordValue(props, "pageProps") : null;
  const data = pageProps ? recordValue(pageProps, "data") : null;
  return {
    hasNextData: Boolean(nextDataMatch),
    nextDataMatchLength: nextDataMatch?.[1].length ?? 0,
    hasSearchAdsText: html.includes('"searchAds"'),
    hasReactFlight: html.includes("__next_f.push"),
    nextDataCount: count(html, "__NEXT_DATA__"),
    searchAdsCount: count(html, "searchAds"),
    reactFlightCount: count(html, "__next_f.push"),
    jsonLdCount: count(html, "application/ld+json"),
    propsKeys: props ? Object.keys(props) : [],
    pagePropsKeys: pageProps ? Object.keys(pageProps) : [],
    dataKeys: data ? Object.keys(data) : [],
  };
}

function safelyParse(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return null; } }
function count(value: string, needle: string): number { return value.split(needle).length - 1; }
