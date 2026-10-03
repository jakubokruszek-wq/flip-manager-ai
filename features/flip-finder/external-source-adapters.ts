import { load } from "cheerio";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { calculateContentHash } from "./otodom-search";
import type { ExternalSourceConfig, ExternalSourceId } from "./external-source-parser";

export type ExternalPortalPage = { listings: PropertySourceListing[]; hasNextPage: boolean };
type PortalRecord = Record<string, unknown>;
type PortalCandidate = { id?: unknown; url?: unknown; title?: unknown; description?: unknown; price?: unknown; area?: unknown; rooms?: unknown; floor?: unknown; city?: unknown; district?: unknown; images?: unknown; publishedAt?: unknown };
type PortalParser = (html: string, fallbackCity: string) => ExternalPortalPage;

const MAX_PAGES = 5;
const TRACKING_PARAM = /^(utm_|fbclid|gclid|dclid|msclkid|yclid|ref$)/iu;
const RENTAL_SIGNAL = /\b(wynajem|wynajm|najem|rent|do wynajęcia|do wynajecia|mieszkanie za remont)\b/iu;

/** Each portal has a separate parser. Only the final canonical mapping is shared. */
export const EXTERNAL_PORTAL_PARSERS: Record<ExternalSourceId, PortalParser> = {
  gratka: parseGratka,
  nieruchomosci_online: parseNieruchomosciOnline,
  domiporta: parseDomiporta,
  sprzedajemy: parseSprzedajemy,
  adresowo: parseAdresowo,
  oferty_net: parseOfertyNet,
  szybko: parseSzybko,
  bezposrednio: parseBezposrednio,
  domy: parseDomy,
  allegro_lokalnie: parseAllegroLokalnie,
};

export async function fetchExternalPortal(config: ExternalSourceConfig, criteria: { city: string | null }, signal?: AbortSignal): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  const parser = EXTERNAL_PORTAL_PARSERS[config.id];
  const listings: PropertySourceListing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (signal?.aborted) throw new Error(`${config.label}: request aborted.`);
    const url = pageUrl(config, criteria.city ?? "", page);
    const response = await fetchExternalPage(url, signal);
    if (!response.ok) throw new Error(`${config.label}: HTTP ${response.status}.`);
    const parsed = parser(await response.text(), criteria.city ?? "");
    fetched += parsed.listings.length;
    for (const listing of parsed.listings) {
      const identity = `${listing.source}:${listing.externalListingId}:${listing.normalizedUrl}`;
      if (!seen.has(identity)) { seen.add(identity); listings.push(listing); }
    }
    if (!parsed.hasNextPage) break;
  }
  if (!listings.length) warnings.push(`${config.label}: odpowiedź nie zawiera zweryfikowanych ofert sprzedaży.`);
  return { listings, warnings, fetched };
}

async function fetchExternalPage(url: string, signal?: AbortSignal): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) throw new Error("external source request aborted.");
    response = await fetch(url, { cache: "no-store", headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "User-Agent": "FlipManager/1.0" }, redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
    if ((response.status !== 429 && response.status < 500) || attempt === 2) return response;
    await retryDelay(attempt, signal);
  }
  if (!response) throw new Error("external source request did not return a response.");
  return response;
}

async function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 150 * 2 ** (attempt - 1));
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("external source request aborted.")); }, { once: true });
  });
}

function pageUrl(config: ExternalSourceConfig, city: string, page: number): string {
  const base = new URL(config.searchPath(city), `https://${config.hostnames[0]}`);
  if (page > 1) base.searchParams.set("page", String(page));
  return base.toString();
}

// Real public structure, confirmed against gratka.pl/nieruchomosci/mieszkania/<city>
// (read-only GET, 2026-10-03): the page embeds exactly one schema.org Product
// whose `offers` is a single AggregateOffer carrying every visible listing as
// its own nested Offer in `offers.offers[]` -- never an ItemList, and never one
// JSON-LD record per listing the way domiporta/adresowo/szybko/domy render.
// jsonLdRecords() only recurses into `@graph`, so it hands back that one
// top-level Product record; its own `offers`/`itemOffered` fields are the
// page-level aggregate (lowPrice/highPrice, no single listing), not a listing
// itself -- mapping it directly (the previous implementation) always produced
// a single, price-less, non-listing candidate that failed validation, so this
// source silently returned zero listings regardless of how many were on the
// page.
function parseGratka(html: string, fallbackCity: string): ExternalPortalPage {
  const aggregate = jsonLdRecords(html).find((record) => isRecord(record.offers) && Array.isArray((record.offers as PortalRecord).offers));
  const offers = aggregate ? ((aggregate.offers as PortalRecord).offers as unknown[]).filter(isRecord) : [];
  return fromCandidates("gratka", offers.map(fromGratkaOfferRecord), fallbackCity, hasNextMarker(html));
}

function parseNieruchomosciOnline(html: string, fallbackCity: string): ExternalPortalPage {
  const data = nextData(html);
  const rows = arrayAt(data, ["props", "pageProps", "ads"]) ?? arrayAt(data, ["props", "pageProps", "data", "ads"]) ?? [];
  const candidates = rows.filter(isRecord).map((row) => ({ id: row.id ?? row.offerId, url: row.href ?? row.url, title: row.title ?? row.name, description: row.description, price: row.price ?? atPath(row, ["offers", "price"]), area: atPath(row, ["area", "value"]) ?? row.area, rooms: row.rooms ?? row.numberOfRooms, floor: row.floor, city: row.city, district: row.district, images: row.images, publishedAt: row.publishedAt }));
  return fromCandidates("nieruchomosci_online", candidates, fallbackCity, Boolean(atPath(data, ["props", "pageProps", "pagination", "hasNext"])));
}

function parseDomiporta(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html); const candidates: PortalCandidate[] = [];
  $("article[data-offer-id], [data-listing-id], [data-testid='listing-card']").each((_, element) => { const card = $(element); const image = card.find("img").first().attr("src") ?? card.find("img").first().attr("data-src"); candidates.push({ id: card.attr("data-offer-id") ?? card.attr("data-listing-id"), url: card.attr("data-url") ?? card.find("a[href]").first().attr("href"), title: card.attr("data-title") ?? card.find("h2,h3,[data-title]").first().text(), price: card.attr("data-price") ?? card.find("[data-price],.price").first().text(), area: card.attr("data-area") ?? card.find("[data-area],.area").first().text(), rooms: card.attr("data-rooms") ?? card.find("[data-rooms],.rooms").first().text(), city: card.attr("data-city") ?? fallbackCity, district: card.attr("data-district"), images: image ? [image] : [] }); });
  return fromCandidates("domiporta", candidates, fallbackCity, Boolean($("a[rel='next'], [data-next-page='true']").length));
}

function parseSprzedajemy(html: string, fallbackCity: string): ExternalPortalPage {
  const state = namedJson(html, "__INITIAL_STATE__"); const rows = arrayAt(state, ["offers"]) ?? arrayAt(state, ["search", "offers"]) ?? [];
  const candidates = rows.filter(isRecord).map((row) => ({ id: row.id ?? row.offerId, url: row.url ?? row.link, title: row.title ?? row.name, description: row.description, price: row.price, area: row.area ?? row.m2, rooms: row.rooms, city: row.city, district: row.district, images: row.images ?? row.photos, publishedAt: row.createdAt ?? row.publishedAt }));
  return fromCandidates("sprzedajemy", candidates, fallbackCity, Boolean(atPath(state, ["pagination", "next"])));
}

function parseAdresowo(html: string, fallbackCity: string): ExternalPortalPage {
  const records = jsonLdRecords(html).filter((record) => /residence|apartment|house|product/iu.test(text(record, "@type") ?? ""));
  return fromCandidates("adresowo", records.map(fromAdresowoRecord), fallbackCity, hasNextMarker(html));
}

function parseOfertyNet(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html); const candidates: PortalCandidate[] = [];
  $("article[data-offer-id], .offer[data-id], [data-listing-id]").each((_, element) => { const card = $(element); candidates.push({ id: card.attr("data-offer-id") ?? card.attr("data-id") ?? card.attr("data-listing-id"), url: card.attr("data-url") ?? card.find("a[href]").first().attr("href"), title: card.find("h2,h3,.title").first().text(), price: card.find(".price,[data-price]").first().text() || card.attr("data-price"), area: card.find(".area,[data-area]").first().text() || card.attr("data-area"), rooms: card.find(".rooms,[data-rooms]").first().text() || card.attr("data-rooms"), city: card.attr("data-city") ?? fallbackCity, district: card.attr("data-district"), images: card.find("img").map((__, image) => $(image).attr("src") ?? $(image).attr("data-src")).get() }); });
  return fromCandidates("oferty_net", candidates, fallbackCity, Boolean($("a[rel='next'], [data-next-page='true']").length));
}

function parseSzybko(html: string, fallbackCity: string): ExternalPortalPage {
  const records = jsonLdRecords(html).flatMap((record) => Array.isArray(record.itemListElement) ? record.itemListElement.filter(isRecord).map((item) => isRecord(item.item) ? item.item : item) : [record]);
  return fromCandidates("szybko", records.map(fromSzybkoRecord), fallbackCity, hasNextMarker(html));
}

function parseBezposrednio(html: string, fallbackCity: string): ExternalPortalPage {
  const data = nextData(html); const rows = arrayAt(data, ["props", "pageProps", "listings"]) ?? arrayAt(data, ["props", "pageProps", "results"]) ?? [];
  const candidates = rows.filter(isRecord).map((row) => ({ id: row.id ?? row.slug, url: row.url ?? row.href, title: row.title ?? row.name, description: row.description, price: row.price, area: row.area, rooms: row.rooms, floor: row.floor, city: row.city, district: row.district, images: row.images, publishedAt: row.publishedAt }));
  return fromCandidates("bezposrednio", candidates, fallbackCity, Boolean(atPath(data, ["props", "pageProps", "pagination", "hasNextPage"])));
}

function parseDomy(html: string, fallbackCity: string): ExternalPortalPage {
  const records = jsonLdRecords(html).filter((record) => /product|offer|residence|apartment/iu.test(text(record, "@type") ?? ""));
  return fromCandidates("domy", records.map(fromDomyRecord), fallbackCity, hasNextMarker(html));
}

function parseAllegroLokalnie(html: string, fallbackCity: string): ExternalPortalPage {
  const data = nextData(html); const rows = arrayAt(data, ["props", "pageProps", "items"]) ?? arrayAt(data, ["props", "pageProps", "offers"]) ?? [];
  const candidates = rows.filter(isRecord).map((row) => ({ id: row.id ?? row.offerId, url: row.url ?? row.href, title: row.title ?? row.name, description: row.description, price: isRecord(row.price) ? row.price.amount : row.price, area: row.area ?? row.size, rooms: row.rooms, city: row.city, district: row.district, images: row.images ?? row.photos, publishedAt: row.createdAt ?? row.publishedAt }));
  return fromCandidates("allegro_lokalnie", candidates, fallbackCity, Boolean(atPath(data, ["props", "pageProps", "pagination", "hasNext"])));
}

// Each nested Offer carries its own itemOffered/address -- but Gratka puts the
// LISTING'S OWN DISTRICT in address.addressLocality (e.g. "Teofilów",
// "Dąbrowa", "Śródmieście" -- all real Łódź districts in the confirmed live
// data), never a separate city. There is no per-offer sku/productID/
// identifier field in the real data; city is deliberately left unset here so
// toListing()'s own existing fallbackCity logic supplies it, exactly as it
// already does for every other adapter lacking an explicit per-candidate city.
function fromGratkaOfferRecord(record: PortalRecord): PortalCandidate {
  const itemOffered = isRecord(record.itemOffered) ? record.itemOffered : record;
  const url = text(record, "url");
  return { id: record.sku ?? record.productID ?? record.identifier ?? (url ? gratkaIdFromUrl(url) : undefined), url: record.url, title: record.name, description: itemOffered.description, price: record.price, area: atPath(itemOffered, ["floorSize", "value"]) ?? itemOffered.area, rooms: itemOffered.numberOfRooms, floor: itemOffered.floorLevel, district: atPath(itemOffered, ["address", "addressLocality"]), images: record.image, publishedAt: record.datePosted ?? record.datePublished };
}
function gratkaIdFromUrl(url: string): string | null { try { return new URL(url).pathname.split("/").filter(Boolean).pop() ?? null; } catch { return null; } }
function fromAdresowoRecord(record: PortalRecord): PortalCandidate { const offered = isRecord(record.itemOffered) ? record.itemOffered : record; return { id: record.identifier ?? record.sku, url: record.url ?? record.mainEntityOfPage, title: record.name, description: record.description, price: atPath(record, ["offers", "price"]) ?? record.price, area: atPath(offered, ["floorSize", "value"]) ?? offered.area, rooms: offered.numberOfRooms, floor: offered.floorLevel, city: atPath(offered, ["address", "addressLocality"]), district: atPath(offered, ["address", "addressSuburb"]), images: record.image, publishedAt: record.datePosted }; }
function fromSzybkoRecord(record: PortalRecord): PortalCandidate { const offered = isRecord(record.itemOffered) ? record.itemOffered : record; return { id: record.sku ?? record.productID ?? record.identifier, url: record.url, title: record.name, description: record.description, price: atPath(record, ["offers", "price"]) ?? record.price, area: atPath(offered, ["floorSize", "value"]) ?? offered.area, rooms: offered.numberOfRooms, floor: offered.floorLevel, city: atPath(offered, ["address", "addressLocality"]), district: atPath(offered, ["address", "addressSuburb"]), images: record.image, publishedAt: record.datePosted }; }
function fromDomyRecord(record: PortalRecord): PortalCandidate { const offered = isRecord(record.itemOffered) ? record.itemOffered : record; return { id: record.sku ?? record.productID, url: record.url, title: record.name, description: record.description, price: atPath(record, ["offers", "price"]) ?? record.price, area: atPath(offered, ["floorSize", "value"]) ?? offered.area, rooms: offered.numberOfRooms, floor: offered.floorLevel, city: atPath(offered, ["address", "addressLocality"]), district: atPath(offered, ["address", "addressSuburb"]), images: record.image, publishedAt: record.datePosted }; }

function fromCandidates(source: ExternalSourceId, candidates: PortalCandidate[], fallbackCity: string, hasNextPage: boolean): ExternalPortalPage { const listings: PropertySourceListing[] = []; const seen = new Set<string>(); for (const candidate of candidates) { const listing = toListing(source, candidate, fallbackCity); if (!listing || seen.has(listing.externalListingId)) continue; seen.add(listing.externalListingId); listings.push(listing); } return { listings, hasNextPage }; }
function toListing(source: ExternalSourceId, candidate: PortalCandidate, fallbackCity: string): PropertySourceListing | null { const url = absoluteUrl(candidate.url, source); const title = stringValue(candidate.title); const description = stringValue(candidate.description); if (!url || isSearchUrl(url) || RENTAL_SIGNAL.test(`${title ?? ""} ${description ?? ""}`)) return null; const price = money(candidate.price); const area = decimal(candidate.area); if (price === null || price <= 0 || area === null || area <= 0) return null; const city = stringValue(candidate.city) ?? fallbackCity; const district = stringValue(candidate.district); const externalListingId = stringValue(candidate.id) ?? new URL(url).pathname.replace(/\/+$/u, ""); const images = imageValues(candidate.images); const rooms = decimal(candidate.rooms); const payload = { id: externalListingId, url: normalizeUrl(url), title, price, area, rooms, city, district }; return { source, externalListingId, originalUrl: url, normalizedUrl: payload.url, title, price, area, rooms, floor: stringValue(candidate.floor), pricePerSqm: price / area, city, district, locationText: [district, city].filter(Boolean).join(", ") || null, thumbnailUrl: images[0] ?? null, images, buildingType: null, description: description ? stripHtml(description) : null, publishedAt: stringValue(candidate.publishedAt), rawPayload: { source, candidate }, contentHash: calculateContentHash(payload) }; }

function absoluteUrl(value: unknown, source: ExternalSourceId): string | null { const raw = stringValue(value); if (!raw) return null; const host = SOURCE_HOSTS[source]; try { const url = new URL(raw, `https://${host}`); if (url.protocol !== "https:" || (url.hostname !== host && !url.hostname.endsWith(`.${host}`))) return null; return url.toString(); } catch { return null; } }
function isSearchUrl(value: string): boolean { const path = new URL(value).pathname.toLocaleLowerCase("pl-PL"); return /\/(wyniki|search|szukaj|mieszkania\/sprzedam|nieruchomosci\/mieszkania\/sprzedam|oferty\/nieruchomosci\/mieszkania|nieruchomosci\/mieszkania\/[a-z-]+)\/?$/u.test(path); }
function normalizeUrl(value: string): string { const url = new URL(value); url.hash = ""; url.hostname = url.hostname.toLowerCase(); for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key); url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/"; return url.toString(); }
function jsonLdRecords(html: string): PortalRecord[] { const output: PortalRecord[] = []; for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) { try { collectJson(JSON.parse(decodeEntities(match[1])), output); } catch { /* malformed blocks are ignored */ } } return output; }
function collectJson(value: unknown, output: PortalRecord[]): void { if (Array.isArray(value)) { value.filter(isRecord).forEach((item) => collectJson(item, output)); return; } if (!isRecord(value)) return; output.push(value); if (Array.isArray(value["@graph"])) value["@graph"].forEach((item) => collectJson(item, output)); }
function nextData(html: string): PortalRecord | null { const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu); if (!match) return null; try { const value = JSON.parse(decodeEntities(match[1])); return isRecord(value) ? value : null; } catch { return null; } }
function namedJson(html: string, name: string): PortalRecord | null { const match = html.match(new RegExp(`${name}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`, "u")); if (!match) return null; try { const value = JSON.parse(match[1]); return isRecord(value) ? value : null; } catch { return null; } }
function hasNextMarker(html: string): boolean { return /(?:rel=["']next["']|data-next-page=["']true["']|["']hasNext(?:Page)?["']\s*:\s*true)/iu.test(html); }
function arrayAt(value: unknown, path: string[]): unknown[] | null { const result = atPath(value, path); return Array.isArray(result) ? result : null; }
function atPath(value: unknown, path: string[]): unknown { let current = value; for (const key of path) { if (!isRecord(current)) return null; current = current[key]; } return current; }
function text(value: PortalRecord, key: string): string | null { return stringValue(value[key]); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function decimal(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/gu, "").replace(",", ".").replace(/[^0-9.+-]/gu, "")) : null; return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null; }
function money(value: unknown): number | null { if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value !== "string") return null; const normalized = value.replace(/\s/gu, "").replace(/zł|pln/giu, ""); const parsed = /^\d{1,3}(?:\.\d{3})+$/.test(normalized) ? Number(normalized.replace(/\./gu, "")) : Number(normalized.replace(/,/gu, ".")); return Number.isFinite(parsed) ? parsed : null; }
function imageValues(value: unknown): string[] { const values = Array.isArray(value) ? value : [value]; return values.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) ? [stringValue(item.url) ?? stringValue(item.contentUrl)].filter((url): url is string => Boolean(url)) : []).filter((url) => /^https?:\/\//iu.test(url)).slice(0, 10); }
function stripHtml(value: string): string { return value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim(); }
function decodeEntities(value: string): string { return value.replace(/&quot;/gu, '"').replace(/&#34;/gu, '"').replace(/&amp;/gu, "&").replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">"); }
function isRecord(value: unknown): value is PortalRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const SOURCE_HOSTS: Record<ExternalSourceId, string> = { gratka: "gratka.pl", nieruchomosci_online: "nieruchomosci-online.pl", domiporta: "domiporta.pl", sprzedajemy: "sprzedajemy.pl", adresowo: "adresowo.pl", oferty_net: "oferty.net", szybko: "szybko.pl", bezposrednio: "bezposrednio.net.pl", domy: "domy.pl", allegro_lokalnie: "allegrolokalnie.pl" };
