import "server-only";

import type { ListingSource, SearchFilter } from "@/features/flip-finder";
import { isOlxChallengeHtml, parseOlxHtml } from "@/features/flip-finder/olx-parser";
import { calculateContentHash, normalizeOtodomUrl } from "@/features/flip-finder/otodom-search";
import { searchOtodom } from "@/features/flip-finder/server/otodom-search-adapter";
import type { PropertySourceListing } from "@/features/properties/types/property";
import {
  parseExternalSourceJsonLd,
  type ExternalSourceConfig,
  type ExternalSourceId,
} from "@/features/flip-finder/external-source-parser";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const SOURCE_MAX_ATTEMPTS = 2;

export type SourceListing = PropertySourceListing;

export type SourceFetchResult = { listings: SourceListing[]; warnings: string[]; fetched: number };
export type SearchSource = {
  id: Exclude<ListingSource, "facebook">;
  label: string;
  fetch(criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult>;
};

export const EXTERNAL_SOURCE_CONFIGS: ExternalSourceConfig[] = [
  { id: "gratka", label: "Gratka", hostnames: ["gratka.pl"], searchPath: (city) => `/nieruchomosci/mieszkania/sprzedam/${slugifyCity(city)}` },
  { id: "nieruchomosci_online", label: "Nieruchomosci-online.pl", hostnames: ["nieruchomosci-online.pl"], searchPath: (city) => `/sprzedaz/mieszkanie/${slugifyCity(city)}.html` },
  { id: "domiporta", label: "Domiporta", hostnames: ["domiporta.pl"], searchPath: (city) => `/mieszkanie/sprzedam/lodzkie/${slugifyCity(city)}` },
  { id: "sprzedajemy", label: "Sprzedajemy.pl", hostnames: ["sprzedajemy.pl"], searchPath: (city) => `/${slugifyCity(city)}/nieruchomosci/mieszkania` },
  { id: "adresowo", label: "Adresowo.pl", hostnames: ["adresowo.pl"], searchPath: (city) => `/mieszkania/${slugifyCity(city)}/` },
  { id: "oferty_net", label: "Oferty.net", hostnames: ["oferty.net"], searchPath: (city) => `/mieszkania/sprzedam/${slugifyCity(city)}` },
  { id: "szybko", label: "Szybko.pl", hostnames: ["szybko.pl"], searchPath: (city) => `/${slugifyCity(city)}/mieszkania/sprzedaz` },
  { id: "bezposrednio", label: "Bezposrednio.net.pl", hostnames: ["bezposrednio.net.pl"], searchPath: (city) => `/mieszkania/${slugifyCity(city)}` },
  { id: "domy", label: "Domy.pl", hostnames: ["domy.pl"], searchPath: (city) => `/mieszkania/sprzedam/${slugifyCity(city)}` },
  { id: "allegro_lokalnie", label: "Allegro Lokalnie", hostnames: ["allegrolokalnie.pl"], searchPath: () => "/oferty/nieruchomosci/mieszkania" },
];

export const EXTERNAL_SOURCE_STATUS = {
  gratka: "path_requires_live_source_verification",
  nieruchomosci_online: "path_requires_live_source_verification",
  domiporta: "public_html_adapter",
  sprzedajemy: "public_html_adapter",
  adresowo: "public_html_adapter",
  oferty_net: "path_requires_live_source_verification",
  szybko: "public_html_adapter",
  bezposrednio: "access_limited_without_authentication",
  domy: "public_html_adapter",
  allegro_lokalnie: "public_html_adapter",
} as const satisfies Record<ExternalSourceId, string>;

export const SOURCES: SearchSource[] = [
  { id: "otodom", label: "Otodom", fetch: fetchOtodom },
  { id: "olx", label: "OLX", fetch: fetchOlx },
  { id: "morizon", label: "Morizon", fetch: fetchMorizon },
  ...EXTERNAL_SOURCE_CONFIGS.map((config) => ({ id: config.id, label: config.label, fetch: (criteria: SearchFilter, signal?: AbortSignal) => fetchExternal(config, criteria, signal) })),
];

export function activeSources(criteria: SearchFilter): SearchSource[] {
  return SOURCES.filter((source) => criteria.sources.includes(source.id));
}

export function slugifyCity(city: string | null): string {
  return (city ?? "")
    .trim()
    .toLocaleLowerCase("pl-PL")
    .replace(/[łŁ]/g, "l")
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
    // Keep the raw count here. A page with 26 rows and zero normalized
    // listings must still show operators "26 found" plus the concrete
    // rejection reasons, rather than silently becoming "0 found".
    fetched: result.rawItems,
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
  const result = parseOlxHtml(html);
  return { listings: result.listings, fetched: result.rawItems, warnings: result.warnings };
}

async function fetchMorizon(criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult> {
  const html = await fetchHtml(`https://www.morizon.pl/mieszkania/${slugifyCity(criteria.city)}/`, "Morizon", signal);
  const offers = parseMorizonOffers(html);
  const listings = offers.map((offer) => toMorizonListing(offer, criteria.city)).filter((item): item is SourceListing => item !== null);
  return { listings, fetched: offers.length, warnings: offers.length ? [] : ["Morizon zwrócił pustą listę ofert."] };
}

async function fetchExternal(config: ExternalSourceConfig, criteria: SearchFilter, signal?: AbortSignal): Promise<SourceFetchResult> {
  const url = new URL(config.searchPath(criteria.city ?? ""), `https://${config.hostnames[0]}`).toString();
  const html = await fetchHtml(url, config.label, signal);
  const listings = parseExternalSourceJsonLd(html, config, criteria.city);
  return {
    listings,
    fetched: listings.length,
    warnings: listings.length ? [] : [`${config.label}: odpowiedź nie zawiera zweryfikowanych ofert sprzedaży w JSON-LD.`],
  };
}

async function fetchHtml(url: string, source: string, signal?: AbortSignal): Promise<string> {
  const headers: Record<string, string> = source === "OLX"
    ? { Accept: ACCEPT, "Accept-Language": "pl-PL,pl;q=0.9,en-US;q=0.7,en;q=0.6", Referer: "https://www.olx.pl/", "User-Agent": USER_AGENT }
    : { Accept: ACCEPT, "User-Agent": USER_AGENT };
  let response: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SOURCE_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error(source + ": request aborted.");
    try {
      response = await fetch(url, { cache: "no-store", headers, redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
      if ((response.status === 429 || response.status >= 500) && attempt < SOURCE_MAX_ATTEMPTS) {
        await retryDelay(attempt, signal);
        continue;
      }
      break;
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === SOURCE_MAX_ATTEMPTS) break;
      await retryDelay(attempt, signal);
    }
  }
  if (!response) throw new Error(source + ": connection error (" + (lastError instanceof Error ? lastError.name : "unknown") + ").");
  if (source === "OLX" && process.env.NODE_ENV === "development") {
    console.info("OLX REQUEST", JSON.stringify({ url, status: response.status, contentType: response.headers.get("content-type"), redirected: response.redirected, finalUrl: response.url }));
  }
  const html = await response.text();
  console.info("FLIP FINDER SOURCE RESPONSE:", { source, url, status: response.status, contentType: response.headers.get("content-type"), finalUrl: response.url, bodyLength: html.length });
  if (response.status === 403 || response.status === 429) throw new Error(source + ": HTTP " + response.status + ".");
  if (!response.ok) throw new Error(source + ": HTTP " + response.status + ".");
  if (source === "OLX" && isOlxChallengeHtml(html)) throw new Error(source + ": challenge HTML.");
  return html;
}

async function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 150 * 2 ** (attempt - 1));
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
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
  return listing("morizon", idFromUrl(url) ?? hash(url), url, text(offer, "name"), price, area, number(item.numberOfRooms), text(item, "floorLevel"), district ? fallbackCity : locality ?? fallbackCity, district, text(item, "description"), imageValues(offer.image), null, offer, text(offer, "datePosted", "datePublished", "dateCreated"));
}

function listing(source: SourceListing["source"], id: string, url: string, title: string | null, price: number | null, area: number | null, roomCount: number | null, floor: string | null, city: string | null, district: string | null, description: string | null, images: string[], buildingType: string | null, rawPayload: Record<string, unknown>, publishedAt: string | null = null): SourceListing {
  const locationText = [district, city].filter(Boolean).join(", ") || null; const normalizedUrl = normalizeOtodomUrl(url);
  const payload = { id, url: normalizedUrl, title, price, area, roomCount, floor, city, district };
  return { source, externalListingId: id, originalUrl: url, normalizedUrl, title, price, area, rooms: roomCount, floor, pricePerSqm: price !== null && area ? price / area : null, city, district, locationText, images, thumbnailUrl: images[0] ?? null, buildingType, description, publishedAt, rawPayload, contentHash: calculateContentHash(payload) };
}

function absoluteUrl(value: string | null, base: string, host: string): string | null { if (!value) return null; try { const url = new URL(value, base); return url.hostname === host || url.hostname.endsWith(`.${host}`) ? url.toString() : null; } catch { return null; } }
function imageValues(value: unknown): string[] { return (Array.isArray(value) ? value : [value]).filter((item): item is string => Boolean(item)).slice(0, 10); }
function number(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/g, "").replace(",", ".")) : null; return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null; }
function text(value: Record<string, unknown>, ...keys: string[]): string | null { const found = keys.map((key) => value[key]).find((item) => typeof item === "string"); return typeof found === "string" && found.trim() ? found.trim() : null; }
function atPath(value: unknown, path: string[]): unknown { let current: unknown = value; for (const key of path) { if (!isRecord(current)) return null; current = current[key]; } return current; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function idFromUrl(url: string | null): string | null { return url?.match(/-ID([^/.]+)|\/([^/?#]+)\/?$/)?.slice(1).find(Boolean) ?? null; }
function hash(value: string): string { let result = 5381; for (const char of value) result = (result * 33) ^ char.charCodeAt(0); return (result >>> 0).toString(16); }
function normalize(value: string): string { return value.toLocaleLowerCase("pl-PL").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l"); }
