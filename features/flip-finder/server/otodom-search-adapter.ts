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
  isConfirmedOtodomOfferUrl,
  normalizeOtodomUrl,
} from "@/features/flip-finder/otodom-search";
import {
  classifyOtodomUrl,
  rejectionWarnings,
  type OtodomRejectionCounts,
  type OtodomRejectionReason,
} from "@/features/flip-finder/otodom-normalization";
import type { PropertySearchListing } from "@/features/properties/types/property";
import { resolveBuildingType, resolveOwnership } from "@/features/flip-finder/listing-attribute-extraction";
import { extractListingIdentityEvidence } from "@/features/flip-finder/identity-evidence";

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
  rejectionReasons: OtodomRejectionCounts;
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
  const normalization = searchAds.items.map((item) => normalizeItem(item));
  const rejectionReasons: OtodomRejectionCounts = {};
  const normalized: PropertySearchListing[] = [];
  const seenExternalIds = new Set<string>();
  const seenUrls = new Set<string>();
  for (const item of normalization) {
    if (!item.listing) {
      incrementReason(rejectionReasons, item.reason ?? "parser_error");
      continue;
    }
    const duplicate = seenExternalIds.has(item.listing.externalListingId) || seenUrls.has(item.listing.normalizedUrl);
    if (duplicate) {
      incrementReason(rejectionReasons, "duplicate");
      continue;
    }
    seenExternalIds.add(item.listing.externalListingId);
    seenUrls.add(item.listing.normalizedUrl);
    normalized.push(item.listing);
  }
  console.info("OTODOM NORMALIZATION SUMMARY:", { rawItems: searchAds.items.length, normalizedItems: normalized.length, rejectedItems: searchAds.items.length - normalized.length, rejectionReasons });
  const listings = normalized.slice(0, MAX_LISTINGS);
  const warnings: string[] = [...rejectionWarnings(rejectionReasons)];

  if (searchAds.items.length === 0) {
    warnings.push("Otodom zwrócił pustą pierwszą stronę wyników dla tego filtra.");
  } else if (listings.length === 0 && Object.keys(rejectionReasons).length === 0) {
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
  return { listings, rawItems: searchAds.items.length, normalizedItems: normalized.length, warnings, rejectionReasons };
}

function itemShape(item: Record<string, unknown>) {
  return { itemKeys: Object.keys(item), idType: typeof item.id, hasSlug: "slug" in item, hasUrl: "url" in item, totalPriceType: typeof item.totalPrice, priceType: typeof item.price, areaInSquareMetersType: typeof item.areaInSquareMeters, areaType: typeof item.area, roomsNumberType: typeof item.roomsNumber, floorNumberType: typeof item.floorNumber, locationKeys: isRecord(item.location) ? Object.keys(item.location) : [], imageKeys: Array.isArray(item.images) && isRecord(item.images[0]) ? Object.keys(item.images[0]) : [], totalPriceKeys: isRecord(item.totalPrice) ? Object.keys(item.totalPrice) : [], priceKeys: isRecord(item.price) ? Object.keys(item.price) : [], propertiesKeys: isRecord(item.properties) ? Object.keys(item.properties) : [], estateKeys: isRecord(item.estate) ? Object.keys(item.estate) : [] };
}

function normalizeItem(item: Record<string, unknown>): { listing: PropertySearchListing | null; reason: OtodomRejectionReason | null } {
  try {
    const reason = normalizationReason(item);
    return reason ? { listing: null, reason } : { listing: toListing(item), reason: null };
  } catch {
    return { listing: null, reason: "parser_error" };
  }
}

function normalizationReason(item: Record<string, unknown>): OtodomRejectionReason | null {
  const candidates = urlCandidates(item);
  if (candidates.length === 0) return "invalid_url";
  const url = listingUrl(item);
  if (!url) {
    // Preserve the most useful diagnostic when every candidate is unusable,
    // but never let a bad `url` field mask a valid `href` in the same row.
    const reasons = candidates.map((candidate) => classifyOtodomUrl(candidate));
    return reasons.find((reason) => reason === "placeholder_url")
      ?? reasons.find((reason) => reason === "search_or_category_url")
      ?? reasons.find((reason) => reason === "missing_offer_id")
      ?? reasons.find((reason) => reason !== null)
      ?? "invalid_url";
  }
  if (!text(item, "id", "adId", "listingId") && !extractOtodomListingId(url)) return "missing_offer_id";
  if (!text(item, "title", "name")) return "missing_title";
  const price = numberValue(item.totalPrice ?? item.price);
  if (price === null || price <= 0) return "missing_price";
  const area = numberValue(item.areaInSquareMeters ?? item.area);
  if (area === null || area <= 0) return "missing_area";
  return null;
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
  const description = text(row, "description", "descriptionText", "advertDescription");
  const structuredBuildingType = row.buildingType ?? row.building_type;
  const structuredOwnership = row.ownership ?? row.ownershipType ?? row.tenure;
  const rooms = mapRoomsNumber(row.roomsNumber ?? row.rooms);
  const floor = mapFloorNumber(row.floorNumber ?? row.floor);
  const images = imageUrls(row);
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
  const buildingType = resolveBuildingType(structuredBuildingType, title, description);
  const identityEvidence = extractListingIdentityEvidence({ source: "otodom", title, description, address, city, district, area, rooms, floor, marketType: text(row, "marketType", "marketTypeName"), buildingType, images, sourceRecord: row });

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
    description,
    buildingType,
    ownership: resolveOwnership(structuredOwnership, title, description),
    thumbnailUrl: thumbnailUrl(row),
    images,
    sellerType: text(row, "sellerType", "advertiserType"),
    marketType: text(row, "marketType"),
    publishedAt: text(row, "createdAt", "publishedAt"),
    rawPayload,
    identityEvidence,
    contentHash: calculateContentHash(rawPayload),
  };
}

function imageUrls(row: Record<string, unknown>): string[] {
  const values = Array.isArray(row.images) ? row.images : row.image ? [row.image] : [];
  return values.flatMap((value) => {
    if (typeof value === "string") return [value];
    if (!isRecord(value)) return [];
    const url = text(value, "large", "medium", "url", "thumbnail");
    return url ? [url] : [];
  }).slice(0, 10);
}

function incrementReason(counts: OtodomRejectionCounts, reason: OtodomRejectionReason): void {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function listingUrl(row: Record<string, unknown>): string | null {
  for (const directUrl of urlCandidates(row)) {
    let resolved: string;
    try {
      resolved = new URL(directUrl, "https://www.otodom.pl").toString();
    } catch {
      continue;
    }
    if (isConfirmedOtodomOfferUrl(resolved)) return resolved;
  }
  // Only a confirmed, dereferenceable single-offer URL is ever kept --
  // never synthesize one from a raw numeric id/adId/listingId field.
  return null;
}

function urlCandidates(row: Record<string, unknown>): string[] {
  return ["url", "href", "link"]
    .map((key) => row[key])
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
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
