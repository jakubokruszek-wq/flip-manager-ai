import type { PropertySourceListing } from "@/features/properties/types/property";
import { calculateContentHash } from "./otodom-search";

export type ExternalSourceId =
  | "gratka"
  | "nieruchomosci_online"
  | "domiporta"
  | "sprzedajemy"
  | "adresowo"
  | "oferty_net"
  | "szybko"
  | "bezposrednio"
  | "domy"
  | "allegro_lokalnie";

export type ExternalSourceConfig = {
  id: ExternalSourceId;
  label: string;
  hostnames: string[];
  searchPath: (city: string) => string;
};

type JsonRecord = Record<string, unknown>;

/**
 * Parses only public JSON-LD embedded in a source response. The parser is
 * deliberately source-agnostic: each portal gets a host and search URL, but
 * the canonical listing shape remains the same and is persisted by
 * persistListing(). No cookies, login flows, or browser APIs are involved.
 */
export function parseExternalSourceJsonLd(
  html: string,
  config: ExternalSourceConfig,
  fallbackCity: string | null,
): PropertySourceListing[] {
  const candidates: JsonRecord[] = [];
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    try {
      const json = JSON.parse(decodeHtmlEntities(match[1])) as unknown;
      collectJsonLd(json, candidates);
    } catch {
      // One malformed script must not hide valid scripts later in the page.
    }
  }
  const listings: PropertySourceListing[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const listing = toListing(candidate, config, fallbackCity);
    if (!listing || seen.has(listing.externalListingId)) continue;
    seen.add(listing.externalListingId);
    listings.push(listing);
  }
  return listings;
}

function collectJsonLd(value: unknown, output: JsonRecord[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLd(item, output);
    return;
  }
  if (!isRecord(value)) return;
  const type = text(value, "@type")?.toLowerCase() ?? "";
  if (value.url || value.offers || value.itemOffered || value.floorSize || value.area || /product|offer|residence|realestate|apartment|house|itemlist/iu.test(type)) {
    output.push(value);
  }
  const graph = value["@graph"];
  if (Array.isArray(graph)) collectJsonLd(graph, output);
  const items = value.itemListElement;
  if (Array.isArray(items)) {
    for (const item of items) collectJsonLd(isRecord(item) && isRecord(item.item) ? item.item : item, output);
  }
  const itemOffered = value.itemOffered;
  if (isRecord(itemOffered)) collectJsonLd(itemOffered, output);
}

function toListing(candidate: JsonRecord, config: ExternalSourceConfig, fallbackCity: string | null): PropertySourceListing | null {
  const url = absoluteListingUrl(candidate, config);
  if (!url || isRental(candidate)) return null;
  const offered = isRecord(candidate.itemOffered) ? candidate.itemOffered : candidate;
  const address = isRecord(offered.address) ? offered.address : {};
  const price = money(firstDefined(candidate, "price", "offers.price", "offers.lowPrice", "offers.highPrice"));
  const area = number(firstDefined(offered, "floorSize.value", "area", "size", "areaValue"));
  if (price === null || price <= 0 || area === null || area <= 0) return null;
  const title = text(candidate, "name") ?? text(offered, "name");
  const description = text(candidate, "description") ?? text(offered, "description");
  const city = text(address, "addressLocality", "addressRegion") ?? fallbackCity;
  const district = text(address, "addressSuburb", "streetAddress") && city && text(address, "addressSuburb") ? text(address, "addressSuburb") : null;
  const images = imageValues(firstDefined(candidate, "image", "images") ?? firstDefined(offered, "image", "images"));
  const externalListingId = stableExternalId(candidate, offered, url);
  const payload = { id: externalListingId, url, title, price, area, rooms: number(firstDefined(offered, "numberOfRooms", "rooms")), city, district };
  return {
    source: config.id,
    externalListingId,
    originalUrl: url,
    normalizedUrl: normalizeUrl(url),
    title,
    price,
    area,
    rooms: payload.rooms,
    floor: text(offered, "floorLevel", "floor"),
    pricePerSqm: price / area,
    city,
    district,
    locationText: [district, city].filter(Boolean).join(", ") || null,
    thumbnailUrl: images[0] ?? null,
    images,
    buildingType: null,
    description: description ? stripHtml(description) : null,
    publishedAt: text(candidate, "datePosted", "datePublished", "dateCreated"),
    rawPayload: { source: config.id, candidate },
    contentHash: calculateContentHash(payload),
  };
}

function absoluteListingUrl(candidate: JsonRecord, config: ExternalSourceConfig): string | null {
  const raw = text(candidate, "url") ?? text(candidate, "mainEntityOfPage") ?? text(candidate, "sameAs");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !config.hostnames.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function stableExternalId(candidate: JsonRecord, offered: JsonRecord, url: string): string {
  return text(candidate, "sku", "productID", "identifier", "id") ?? text(offered, "sku", "productID", "identifier", "id") ?? new URL(url).pathname.replace(/\/+$/u, "");
}

function isRental(candidate: JsonRecord): boolean {
  const textValue = [text(candidate, "name"), text(candidate, "description"), text(candidate, "url")].filter(Boolean).join(" ").toLocaleLowerCase("pl-PL");
  return /\b(wynajem|wynajm|najem|rent|do wynajęcia|mieszkanie za remont)\b/iu.test(textValue);
}

function firstDefined(value: JsonRecord, ...paths: string[]): unknown {
  for (const path of paths) {
    let current: unknown = value;
    for (const key of path.split(".")) {
      if (Array.isArray(current)) current = current.find(isRecord) ?? null;
      if (!isRecord(current)) { current = null; break; }
      current = current[key];
    }
    if (current !== null && current !== undefined) return current;
  }
  return null;
}

function imageValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) ? [text(item, "url", "contentUrl")].filter((url): url is string => Boolean(url)) : []).filter((url) => /^https?:\/\//iu.test(url)).slice(0, 10);
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|dclid|msclkid|yclid|ref$)/iu.test(key)) url.searchParams.delete(key);
  return url.toString();
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/gu, "").replace(",", ".")) : null;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function money(value: unknown): number | null {
  if (typeof value !== "string") return number(value);
  const normalized = value.replace(/\s/gu, "").replace(/zł|pln/giu, "");
  const parsed = /^\d{1,3}(?:\.\d{3})+$/.test(normalized)
    ? Number(normalized.replace(/\./gu, ""))
    : Number(normalized.replace(/,/gu, "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: JsonRecord, ...keys: string[]): string | null {
  const found = keys.map((key) => value[key]).find((item) => typeof item === "string");
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

function stripHtml(value: string): string { return value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim(); }
function decodeHtmlEntities(value: string): string { return value.replace(/&quot;/gu, '"').replace(/&#34;/gu, '"').replace(/&amp;/gu, "&").replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">"); }
function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
