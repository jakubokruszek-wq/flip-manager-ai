import { load } from "cheerio";
import type { PropertySource, PropertySourceListing } from "@/features/properties/types/property";
import { calculateContentHash } from "./otodom-search";
import { classifyOfficialNotice, OFFICIAL_LODZ_SOURCES, type OfficialLodzSource } from "./official-lodz-sources";

export type OfficialCanonicalSource = "official_cooperative" | "official_uml" | "official_auction";
export type OfficialNoticeType = "cooperative_sale" | "municipal_sale" | "auction" | "syndic_sale";
export type OfficialOfferMetadata = {
  sourceId: string;
  noticeType: OfficialNoticeType;
  priceKind: "asking_price" | "starting_bid";
  price: number;
  deposit: number | null;
  deadline: string | null;
  eventDate: string | null;
  eligibilityCriteria: string[];
};
export type OfficialSourceListing = PropertySourceListing & {
  officialOffer: OfficialOfferMetadata;
};
export type OfficialSourcePage = { listings: OfficialSourceListing[]; hasNextPage: boolean; warnings: string[] };
type RawNotice = { id?: string; url?: string; title?: string; text?: string; price?: unknown; deposit?: unknown; deadline?: string; eventDate?: string; area?: unknown; rooms?: unknown; city?: string; district?: string; image?: string; criteria?: string[] };
type OfficialParser = (html: string, source: OfficialLodzSource) => OfficialSourcePage;

const SOURCE_IDS = OFFICIAL_LODZ_SOURCES.filter((source) => source.kind !== "rental_program").map((source) => source.id);
const SOURCE_BY_ID = new Map(OFFICIAL_LODZ_SOURCES.map((source) => [source.id, source]));
const SOURCE_KIND: Record<string, OfficialCanonicalSource> = {
  cooperative: "official_cooperative",
  municipal: "official_uml",
  krk: "official_auction",
  syndic: "official_auction",
};
/** Every catalogued sale source gets an explicit parser, even where two public pages share a layout. */
export const OFFICIAL_LODZ_PARSERS: Record<string, OfficialParser> = Object.fromEntries(
  SOURCE_IDS.map((sourceId) => {
    const source = SOURCE_BY_ID.get(sourceId)!;
    const parser = source.kind === "cooperative" ? parseCooperativeNotice : source.kind === "municipal" ? parseMunicipalNotice : source.kind === "krk" ? parseKrkNotice : parseSyndicNotice;
    return [sourceId, parser];
  }),
) as Record<string, OfficialParser>;

export const OFFICIAL_LODZ_SOURCE_IDS = SOURCE_IDS as readonly string[];

export async function fetchOfficialLodzGroup(group: OfficialCanonicalSource, criteria: { city: string | null }, signal?: AbortSignal): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  const sources = OFFICIAL_LODZ_SOURCES.filter((source) => source.kind !== "rental_program" && SOURCE_KIND[source.kind] === group);
  const all: OfficialSourceListing[] = [];
  const warnings: string[] = [];
  let fetched = 0;
  for (const source of sources) {
    const result = await fetchOfficialSource(source.id, criteria, signal);
    fetched += result.fetched;
    warnings.push(...result.warnings);
    all.push(...result.listings);
  }
  const seen = new Set<string>();
  return { listings: all.filter((listing) => { const key = `${listing.source}:${listing.normalizedUrl}`; if (seen.has(key)) return false; seen.add(key); return true; }), warnings, fetched };
}

export async function fetchOfficialSource(sourceId: string, criteria: { city: string | null }, signal?: AbortSignal): Promise<{ listings: OfficialSourceListing[]; warnings: string[]; fetched: number }> {
  const source = SOURCE_BY_ID.get(sourceId);
  const parser = OFFICIAL_LODZ_PARSERS[sourceId];
  if (!source || !parser) throw new Error(`OFFICIAL_SOURCE_UNSUPPORTED: ${sourceId}`);
  const response = await fetch(source.url, { cache: "no-store", redirect: "follow", headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "User-Agent": "FlipManager/1.0" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${source.label}: HTTP ${response.status}.`);
  const page = parser(await response.text(), source);
  const listings = page.listings.filter((listing) => !criteria.city || listing.city?.toLocaleLowerCase("pl-PL") === criteria.city.toLocaleLowerCase("pl-PL"));
  return { listings, warnings: page.warnings, fetched: page.listings.length };
}

function parseCooperativeNotice(html: string, source: OfficialLodzSource): OfficialSourcePage { return parseNoticeCards(html, source, "cooperative_sale", "article[data-notice-id], [data-notice-id]"); }
function parseMunicipalNotice(html: string, source: OfficialLodzSource): OfficialSourcePage { return parseNoticeCards(html, source, "municipal_sale", "tr[data-notice-id], article[data-notice-id]"); }
function parseKrkNotice(html: string, source: OfficialLodzSource): OfficialSourcePage { return parseNoticeCards(html, source, "auction", "article[data-auction-id], [data-notice-id]"); }
function parseSyndicNotice(html: string, source: OfficialLodzSource): OfficialSourcePage { return parseNoticeCards(html, source, "syndic_sale", "article[data-notice-id], [data-notice-id]"); }

function parseNoticeCards(html: string, source: OfficialLodzSource, noticeType: OfficialNoticeType, selector: string): OfficialSourcePage {
  const $ = load(html);
  const notices: RawNotice[] = [];
  $(selector).each((_, element) => {
    const card = $(element);
    const link = card.find("a[href]").first().attr("href") ?? card.attr("data-url");
    const text = card.text().replace(/\s+/gu, " ").trim();
    const criteria = card.find("[data-field='criteria'] li, [data-criteria] li").map((__, item) => card.find(item).text().trim()).get().filter(Boolean);
    notices.push({
      id: card.attr("data-notice-id") ?? card.attr("data-auction-id"),
      url: link,
      title: card.find("h1,h2,h3,.title,[data-field='title']").first().text().trim() || card.attr("data-title"),
      text,
      price: card.attr("data-price") ?? card.find("[data-field='price'],.price").first().text(),
      deposit: card.attr("data-deposit") ?? card.find("[data-field='deposit'],.deposit,[data-field='wadium']").first().text(),
      deadline: card.attr("data-deadline") ?? (card.find("[data-field='deadline'],.deadline").first().text().trim() || undefined),
      eventDate: card.attr("data-event-date") ?? (card.find("[data-field='event-date'],.event-date,[data-field='auction-date']").first().text().trim() || undefined),
      area: card.attr("data-area") ?? card.find("[data-field='area'],.area").first().text(),
      rooms: card.attr("data-rooms") ?? card.find("[data-field='rooms'],.rooms").first().text(),
      city: card.attr("data-city") ?? "Łódź",
      district: card.attr("data-district") ?? undefined,
      image: card.find("img").first().attr("src") ?? card.find("img").first().attr("data-src"),
      criteria,
    });
  });
  return normalizeNotices(source, noticeType, notices, Boolean($("a[rel='next'], [data-next-page='true']").length));
}

function normalizeNotices(source: OfficialLodzSource, noticeType: OfficialNoticeType, notices: RawNotice[], hasNextPage: boolean): OfficialSourcePage {
  const listings: OfficialSourceListing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const notice of notices) {
    const url = absoluteNoticeUrl(notice.url, source.url);
    const noticeText = `${notice.title ?? ""} ${notice.text ?? ""}`;
    if (!url || classifyOfficialNotice(noticeText, source) !== "sale_candidate") continue;
    const price = money(notice.price);
    const area = decimal(notice.area);
    const id = notice.id?.trim() || new URL(url).pathname.replace(/\/+$/u, "").split("/").pop() || null;
    if (!id || price === null || area === null || area <= 0 || price <= 0 || seen.has(id)) continue;
    seen.add(id);
    const canonicalSource = SOURCE_KIND[source.kind];
    const normalizedUrl = normalizeUrl(url);
    const metadata: OfficialOfferMetadata = { sourceId: source.id, noticeType, priceKind: noticeType === "auction" || noticeType === "syndic_sale" ? "starting_bid" : "asking_price", price, deposit: money(notice.deposit), deadline: cleanDate(notice.deadline), eventDate: cleanDate(notice.eventDate), eligibilityCriteria: notice.criteria ?? [] };
    const payload = { source: canonicalSource, sourceId: source.id, noticeType, id, normalizedUrl, title: notice.title ?? null, price, area, rooms: decimal(notice.rooms), city: notice.city ?? "Łódź", district: notice.district ?? null, officialOffer: metadata };
    listings.push({ source: canonicalSource as PropertySource, externalListingId: `${source.id}:${id}`, originalUrl: url, normalizedUrl, title: notice.title?.trim() || `${source.label} — oferta mieszkaniowa`, price, area, rooms: decimal(notice.rooms), floor: null, pricePerSqm: price / area, city: notice.city ?? "Łódź", district: notice.district ?? null, locationText: [notice.district, notice.city ?? "Łódź"].filter(Boolean).join(", "), thumbnailUrl: validImage(notice.image), images: validImage(notice.image) ? [validImage(notice.image)!] : [], buildingType: null, description: notice.text?.trim() || null, publishedAt: metadata.eventDate, rawPayload: payload, contentHash: calculateContentHash(payload), officialOffer: metadata });
  }
  if (!listings.length) warnings.push(`${source.label}: brak zweryfikowanych ofert mieszkaniowych.`);
  return { listings, hasNextPage, warnings };
}

function absoluteNoticeUrl(value: string | undefined, sourceUrl: string): string | null {
  if (!value) return null;
  try {
    const base = new URL(sourceUrl);
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/u.test(url.protocol) || (host !== base.hostname && !host.endsWith(`.${base.hostname}`))) return null;
    return url.toString();
  } catch { return null; }
}
function normalizeUrl(value: string): string { const url = new URL(value); url.hash = ""; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/iu.test(key)) url.searchParams.delete(key); url.pathname = url.pathname.replace(/\/+$/u, "") || "/"; return url.toString(); }
function money(value: unknown): number | null { if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value !== "string") return null; const normalized = value.replace(/\s/gu, "").replace(/zł|pln/giu, ""); const parsed = /^\d{1,3}(?:\.\d{3})+$/.test(normalized) ? Number(normalized.replace(/\./gu, "")) : Number(normalized.replace(/,/gu, ".")); return Number.isFinite(parsed) ? parsed : null; }
function decimal(value: unknown): number | null { if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value !== "string") return null; const parsed = Number(value.replace(/\s/gu, "").replace(",", ".").replace(/[^0-9.+-]/gu, "")); return Number.isFinite(parsed) ? parsed : null; }
function cleanDate(value: string | undefined): string | null { const result = value?.replace(/\s+/gu, " ").trim(); return result || null; }
function validImage(value: string | undefined): string | null { return value && /^https?:\/\//iu.test(value) ? value : null; }
