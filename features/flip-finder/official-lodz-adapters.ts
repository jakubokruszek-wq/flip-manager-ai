import { load } from "cheerio";
import type { PropertySource, PropertySourceListing } from "@/features/properties/types/property";
import { calculateContentHash } from "./otodom-search";
import { classifyOfficialNotice, OFFICIAL_LODZ_SOURCES, type OfficialLodzSource } from "./official-lodz-sources";
import type { SourceBatchContext } from "./source-batches";
import { extractBuildingType, extractOwnership } from "./listing-attribute-extraction";

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
type RawNotice = { id?: string | null; url?: string | null; title?: string | null; text?: string | null; price?: unknown; deposit?: unknown; deadline?: string | null; eventDate?: string | null; area?: unknown; rooms?: unknown; city?: string | null; district?: string | null; image?: string | null; criteria?: string[] };
type FetchText = (url: string, signal?: AbortSignal) => Promise<string>;
type OfficialParser = (html: string, source: OfficialLodzSource, fetchDetail: FetchText, signal?: AbortSignal, batches?: SourceBatchContext) => Promise<OfficialSourcePage>;

// Two independent whitespace pitfalls in plain cheerio .text() across these
// hand-written notice pages:
// 1. Several sites render "m²" as "m<sup>2</sup>". Naively removing <sup>
//    (to avoid the "72m<sup>2</sup>" -> "72m2" digit-merge bug seen
//    elsewhere in this codebase) instead destroys the unit marker entirely,
//    turning "40,00 m<sup>2</sup>Cena..." into "40,00 mCena..." with no
//    "2"/"²" left at all -- folding the sup into a literal "²" first avoids
//    that.
// 2. cheerio's .text() never inserts a space between adjacent elements, so
//    "...m<sup>2</sup></p><p>Cena..." becomes "...m²Cena..." with the unit
//    and the next sentence fused together -- which then fails the area
//    regex's own "not immediately followed by another letter" check. Block
//    boundaries get an explicit space first so paragraphs/cells never fuse.
function loadNormalized(html: string) {
  const withSpacing = html
    .replace(/<sup>\s*2\s*<\/sup>/giu, "²")
    .replace(/<br\s*\/?>/giu, " ")
    .replace(/<\/(p|div|li|tr|td|h[1-6])>/giu, "</$1> ");
  return load(withSpacing);
}

const SOURCE_IDS = OFFICIAL_LODZ_SOURCES.filter((source) => source.kind !== "rental_program").map((source) => source.id);
const SOURCE_BY_ID = new Map(OFFICIAL_LODZ_SOURCES.map((source) => [source.id, source]));
const SOURCE_KIND: Record<string, OfficialCanonicalSource> = {
  cooperative: "official_cooperative",
  municipal: "official_uml",
  krk: "official_auction",
  syndic: "official_auction",
};

/** Only catalog entries independently verified as public and parseable may run in a group scan. */
export function isOfficialSourceRuntimeEligible(source: OfficialLodzSource): boolean {
  return source.status === "verified_public_page" && typeof OFFICIAL_LODZ_PARSERS[source.id] === "function";
}

/**
 * Every catalogued site runs a different CMS with its own markup (Joomla,
 * WordPress, a bespoke "Strony" CMS, TYPO3, a Nuxt SPA) -- confirmed by
 * direct inspection, not assumed -- so each one gets its own parser
 * function and its own selector. The only thing shared across sites is the
 * final notice-classification step (classifyOfficialNotice, a keyword check
 * on free text) and the Polish legal-notice price/deposit/area vocabulary
 * ("Cena/Kwota wywoławcza wynosi X zł", "Wadium wynosi X zł") that several
 * independently-run cooperatives happen to use when writing up a tender in
 * prose -- that is a shared VOCABULARY to parse once text has already been
 * extracted by a site-specific selector, never a shared selector itself.
 */
export const OFFICIAL_LODZ_PARSERS: Record<string, OfficialParser> = {
  "sm-dabrowa": parseSmDabrowa,
  "sm-teofilow": parseSmTeofilow,
  smtl: parseBlocked("Błąd certyfikatu TLS (schannel SEC_E_WRONG_PRINCIPAL — niezgodność nazwy hosta) przy każdej próbie połączenia; klient weryfikujący certyfikaty (w tym fetch() tej aplikacji) odrzuca połączenie. Nigdy nie pominięto weryfikacji TLS, by to obejść."),
  "sm-chojny": parseBlocked("Strona /przetargi/ odpowiada 200, ale jej treść to ogólny tekst zastępczy (np. „window-tinting services...”) pod nagłówkami „Opis przetargu nr. 1/2”, nie realne ogłoszenia — potwierdzone bezpośrednią inspekcją 2026-10-03."),
  "sm-srodmiescie": parseSmSrodmiescie,
  "sm-karolew": parseSmKarolew,
  "sm-retkinia-polnoc": parseSmRetkiniaPolnoc,
  "sm-retkinia-poludnie": parseSmRetkiniaPoludnie,
  "sm-radogoszcz-wschod": parseSmRadogoszcz,
  "sm-doly-marysinska": parseSmDolyMarysinska,
  "uml-sale": parseUmlMieszkania,
  "bip-uml-sale": parseBlocked("Strona listuje ogłoszenia na poziomie obwieszczenia (wiele adresów naraz, np. „Kalinowej 42, Pabianickiej 37, Włókienniczej 18”), bez ceny per-lokal w HTML listy — wymagałoby osobnego, niezweryfikowanego wejścia w każde obwieszczenie. Te same dane per-lokal już dostarcza uml-sale."),
  "krk-licytacje": parseBlocked("Nuxt 3 SPA: potwierdzone we własnym __NUXT_DATA__ strony, że ładowany po stronie serwera payload zawiera tylko metadane kategorii (np. „antyki, sztuka”), nigdy listę licytacji — wyniki wyszukiwania ładowane są wywołaniem API wyłącznie po stronie klienta."),
  "syndic-public-notices": parseBlocked("Zarejestrowany URL to ogólna strona główna Ministerstwa Sprawiedliwości, bez ogłoszeń syndyków. Realne rejestry (KRZ — krz.ms.gov.pl, MSiG — ems.ms.gov.pl) są systemami wymagającymi sesji/JS, wykluczonymi przez zakaz omijania logowania."),
};

export const OFFICIAL_LODZ_SOURCE_IDS = SOURCE_IDS as readonly string[];

export async function fetchOfficialLodzGroup(group: OfficialCanonicalSource, criteria: { city: string | null }, signal?: AbortSignal, batches?: SourceBatchContext): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  const sources = OFFICIAL_LODZ_SOURCES.filter((source) => isOfficialSourceRuntimeEligible(source) && SOURCE_KIND[source.kind] === group);
  const all: OfficialSourceListing[] = [];
  const warnings: string[] = [];
  let fetched = 0;
  // Low two digits are the next detail within a site (at most 20); the
  // remaining digits select the next verified catalog entry.
  const cursor = batches?.cursor ?? 0;
  for (let index = Math.floor(cursor / 100); index < sources.length; index += 1) {
    const source = sources[index];
    let batch: { listings: PropertySourceListing[]; warnings: string[]; fetched: number };
    let emitted = false;
    let callbackFailed = false;
    // One independently-run site failing (TLS error, timeout, HTTP error,
    // a malformed page) must never take down every other source in the
    // group -- each is isolated so the rest still report their real data.
    try {
      const result = await fetchOfficialSource(source.id, criteria, signal, batches ? {
        cursor: index === Math.floor(cursor / 100) ? cursor % 100 : 0,
        onBatch: async (part, nextDetail) => {
          if (nextDetail !== null && typeof nextDetail !== "number") throw new Error("INVALID_OFFICIAL_SOURCE_CURSOR");
          emitted = true;
          const next = nextDetail === null ? (index + 1 < sources.length ? (index + 1) * 100 : null) : index * 100 + nextDetail;
          try { await batches.onBatch(part, next); } catch (error) { callbackFailed = true; throw error; }
        },
      } : undefined);
      batch = result;
      fetched += result.fetched;
      warnings.push(...result.warnings);
      all.push(...result.listings);
    } catch (error) {
      if (signal?.aborted || callbackFailed) throw error;
      const warning = `${source.label}: ${error instanceof Error ? error.message : "nieznany błąd połączenia"}.`;
      warnings.push(warning);
      batch = { listings: [], warnings: [warning], fetched: 0 };
    }
    // Callback failures (lease lost / budget yield) must escape the group.
    if (batches && !emitted) await batches.onBatch(batch, index + 1 < sources.length ? (index + 1) * 100 : null);
  }
  const seen = new Set<string>();
  return { listings: all.filter((listing) => { const key = `${listing.source}:${listing.normalizedUrl}`; if (seen.has(key)) return false; seen.add(key); return true; }), warnings, fetched };
}

export async function fetchOfficialSource(sourceId: string, criteria: { city: string | null }, signal?: AbortSignal, batches?: SourceBatchContext): Promise<{ listings: OfficialSourceListing[]; warnings: string[]; fetched: number }> {
  const source = SOURCE_BY_ID.get(sourceId);
  const parser = OFFICIAL_LODZ_PARSERS[sourceId];
  if (!source || !parser) throw new Error(`OFFICIAL_SOURCE_UNSUPPORTED: ${sourceId}`);
  const html = await fetchOfficialHtml(source.url, source.charset, signal);
  const fetchDetail: FetchText = (url) => fetchOfficialHtml(url, source.charset, signal);
  const page = await parser(html, source, fetchDetail, signal, batches ? {
    ...batches,
    onBatch: (batch, next) => batches.onBatch({ ...batch, listings: batch.listings.filter((listing) => !criteria.city || listing.city?.toLocaleLowerCase("pl-PL") === criteria.city.toLocaleLowerCase("pl-PL")) }, next),
  } : undefined);
  const listings = page.listings.filter((listing) => !criteria.city || listing.city?.toLocaleLowerCase("pl-PL") === criteria.city.toLocaleLowerCase("pl-PL"));
  return { listings, warnings: page.warnings, fetched: page.listings.length };
}

async function fetchOfficialHtml(url: string, charset: string | undefined, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: "no-store", redirect: "follow", headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "User-Agent": "FlipManager/1.0" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}.`);
  if (!charset || charset.toLowerCase() === "utf-8") return response.text();
  // A small number of these sites declare a Central European 8-bit charset
  // (confirmed via their own <meta charset> tag, not guessed) instead of
  // UTF-8; response.text() would otherwise silently mojibake every
  // diacritic, corrupting every price/area/room-count regex downstream.
  const buffer = await response.arrayBuffer();
  return new TextDecoder(charset).decode(buffer);
}

// ---------------------------------------------------------------------------
// Shared helpers: classification stays keyword-based (already per-source
// configurable via saleNoticeKeywords/excludedNoticeKeywords); only the
// free-text price/deposit/area/room vocabulary below is reused across sites
// that happen to write tenders with the same standard Polish legal phrasing.
// ---------------------------------------------------------------------------

function prosePrice(text: string): number | null {
  const match = text.match(/(?:cena|kwota)\s+wywoławcz\w*\s+wynosi\s*:?\s*([\d\s.,]{2,})\s*zł/iu) ?? text.match(/za\s+cenę\s+nie\s+niższą\s+niż\s*([\d\s.,]{2,})\s*zł/iu);
  return match ? money(match[1]) : null;
}
function proseDeposit(text: string): number | null {
  const match = text.match(/wadium\s+wynosi\s*:?\s*([\d\s.,]{2,})\s*zł/iu) ?? text.match(/kwota\s+wadium\s*:?\s*([\d\s.,]{2,})\s*zł/iu);
  return match ? money(match[1]) : null;
}
function proseArea(text: string): number | null {
  // "pow." (abbreviated) vs "powierzchnia"/"powierzchni" (full word, with
  // or without the nominative "-a") -- \w* after "ierzchni" covers both.
  // Some sites print "m 2" with the unit number space-separated from "m"
  // (confirmed on sm-srodmiescie's real page), so whitespace is allowed
  // between them. \b fails right after "²" (not a \w character) when
  // followed by whitespace -- a non-word-to-non-word pair has no boundary
  // -- so the unit suffix is bounded by a negative lookahead instead.
  const match = text.match(/pow(?:ierzchni\w*)?\.?\s*(?:użytkow\w*)?\s*:?\s*([\d.,]+)\s*m\s*(?:2|²|kw)(?![\p{L}\d])/iu);
  return match ? decimal(match[1]) : null;
}
function proseRooms(text: string): number | null {
  // "1 pokój" (singular, nominative) spells the stem with "ó", while every
  // plural form ("2 pokoje", "2-ch pokoi") spells it with plain "o".
  const match = text.match(/(\d+)[- ]?(?:ch)?\s*pok[oó]/iu);
  return match ? decimal(match[1]) : null;
}
function proseEligibility(text: string): string[] {
  const match = text.match(/OGRANICZONY\s*[–—-]\s*do\s+którego\s+mogą\s+przystąpić\s+wyłącznie:?\s*([^.]+)\./iu);
  return match ? [match[1].replace(/\s+/gu, " ").trim()] : [];
}
function proseDeadline(text: string): string | null {
  const match = text.match(/terminie\s+do\s+dnia\s+([\d.]+\s*r\.?(?:\s*do\s*godz\.?\s*\d{1,2}[:.]?\d{0,2})?)/iu) ?? text.match(/do\s+dnia\s+([\d.]+\s*r\.?(?:\s*do\s*godz\.?\s*\d{1,2}[:.]?\d{0,2})?)/iu);
  return match ? match[1].replace(/\s+/gu, " ").trim() : null;
}
function proseEventDate(text: string): string | null {
  const match = text.match(/[Pp]rzetarg\w*\s+odbędą?\s+się\s+dnia\s+([\d.]+r\.?)/u) ?? text.match(/[Dd]ata\s+przetargu:?\s*([\d.]+)/u);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// sm-dabrowa (Joomla blog-category list, 2-step: list -> detail)
// Real structure confirmed 2026-10-03 against smdabrowa.pl/informacje/
// oferty-przetargi: list teasers (h2 > a) link to full Joomla article
// pages whose body prose states the real price/area/rooms, e.g. "lokal
// mieszkalny nr 83 ... składa się z 2-ch pokoi ... o łącznej pow. użytkowej
// 36,74 m2" and "Cena wywoławcza wynosi 222 000,00 zł".
// ---------------------------------------------------------------------------
async function parseSmDabrowa(html: string, source: OfficialLodzSource, fetchDetail: FetchText, signal?: AbortSignal, batches?: SourceBatchContext): Promise<OfficialSourcePage> {
  const $ = load(html);
  const summaries: NoticeSummary[] = [];
  $("h2 a[href*='/informacje/oferty-przetargi/']").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    if (href) summaries.push({ title: link.text().replace(/\s+/gu, " ").trim(), url: href });
  });
  const notices = await fetchNoticeDetails(source, summaries, fetchDetail, signal, (detailHtml, summary) => {
    const $ = loadNormalized(detailHtml);
    const body = $(".com-content-article__body").first();
    const text = (body.length ? body.text() : $("body").text()).replace(/\s+/gu, " ").trim();
    return { url: summary.url, title: summary.title, text, price: prosePrice(text), area: proseArea(text), rooms: proseRooms(text), deposit: proseDeposit(text), eventDate: $("time[datetime]").first().attr("datetime") ?? null };
  }, batches);
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-teofilow (bespoke HTML, ISO-8859-2 encoded, single page)
// Real structure confirmed 2026-10-03: every notice is a top-level
// `.przetarg` div (some stale ones are wrapped in HTML comments, which
// cheerio's own parser already excludes from element selections -- no
// special stripping needed). Live notices often nest an inner `.przetarg`
// div with the full legal text; `.przetarg` divs nested inside another
// `.przetarg` are skipped so each real notice is only read once.
// ---------------------------------------------------------------------------
async function parseSmTeofilow(html: string, source: OfficialLodzSource): Promise<OfficialSourcePage> {
  const $ = loadNormalized(html);
  const notices: RawNotice[] = [];
  $(".przetarg").each((_, element) => {
    const card = $(element);
    if (card.parents(".przetarg").length > 0) return;
    const title = card.find("h4").first().text().replace(/\s+/gu, " ").trim();
    const text = card.text().replace(/\s+/gu, " ").trim();
    notices.push({ id: textId(text), title, text, price: prosePrice(text), area: proseArea(text), rooms: proseRooms(text), deposit: proseDeposit(text) });
  });
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-srodmiescie (WordPress, single page, structured numbered-list prose)
// Real structure confirmed 2026-10-03: one tender announcement lists every
// unit in a repeating "<code> [zobacz] / powierzchnia: X m², <address>, za
// cenę nie niższą niż X zł , kwota wadium X zł" pattern inside the post
// body -- split into one notice per numbered entry rather than treated as
// a single giant notice, so classification (lokal mieszkalny vs lokal
// użytkowy) applies per unit, not to the whole announcement.
// ---------------------------------------------------------------------------
async function parseSmSrodmiescie(html: string, source: OfficialLodzSource): Promise<OfficialSourcePage> {
  const $ = loadNormalized(html);
  const body = $(".entry-content, article").first();
  const fullText = (body.length ? body.text() : $("body").text()).replace(/\s+/gu, " ").trim();
  // The page groups numbered unit entries under a roman-numeral section
  // heading ("I. Lokali mieszkalnych:", "II. Lokali użytkowych:", ...).
  // Splitting on numbered entries alone would let the trailing text of the
  // LAST entry in a section run into the NEXT section's heading (e.g. a
  // residential "M 5" entry's text would end up containing "Lokali
  // użytkowych" from the following section and get wrongly excluded), so
  // the page is split into sections first, each kept with its own heading.
  const sections = fullText.split(/(?<=^|\s)(?=[IVX]+\.\s*[^:]+:)/u).filter((section) => /^[IVX]+\./u.test(section));
  const notices: RawNotice[] = [];
  for (const section of sections) {
    const heading = section.match(/^([IVX]+\.\s*[^:]+:)/u)?.[1] ?? "";
    const entries = section.slice(heading.length).split(/(?=\d+__\s)/u).filter((entry) => /^\d+__/u.test(entry));
    for (const entry of entries) {
      const code = entry.match(/^(\d+__\s*\S+)/u)?.[1]?.trim() ?? entry.slice(0, 40);
      notices.push({ id: textId(`${heading}:${code}`), title: `${heading} ${entry}`.trim(), text: entry, price: prosePrice(entry), area: proseArea(entry), deposit: proseDeposit(entry) });
    }
  }
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-karolew (bespoke HTML, single page)
// Real structure confirmed 2026-10-03: current/historical tenders are
// plain text blocks introduced by "najnowsze: <date>"; today's live entry
// is a maintenance tender ("remont WLZ, wymianę przykanalików..."),
// correctly excluded -- the parser still reads real page content, it just
// has nothing to keep right now.
// ---------------------------------------------------------------------------
async function parseSmKarolew(html: string, source: OfficialLodzSource): Promise<OfficialSourcePage> {
  const $ = loadNormalized(html);
  $("script, style").remove();
  const text = $("body").text().replace(/\s+/gu, " ").trim();
  const entries = text.split(/(?=najnowsze:)/u).filter((entry) => /najnowsze:/u.test(entry));
  const notices: RawNotice[] = entries.map((entry) => ({ id: textId(entry), title: entry.slice(0, 160), text: entry, price: prosePrice(entry), area: proseArea(entry), deposit: proseDeposit(entry) }));
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-retkinia-polnoc (bespoke "Strony,ID" CMS, 2-step: list -> detail)
// Real structure confirmed 2026-10-03: the Przetargi page is a short link
// list ("przetarg dotyczący wyboru wykonawców", "Wyniki przetargu"); each
// links to its own sub-page with the real body text.
// ---------------------------------------------------------------------------
async function parseSmRetkiniaPolnoc(html: string, source: OfficialLodzSource, fetchDetail: FetchText, signal?: AbortSignal, batches?: SourceBatchContext): Promise<OfficialSourcePage> {
  const $ = load(html);
  const summaries: NoticeSummary[] = [];
  $("#c_text a[href]").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    if (href) summaries.push({ title: link.text().replace(/\s+/gu, " ").trim(), url: href });
  });
  const notices = await fetchNoticeDetails(source, summaries, fetchDetail, signal, (detailHtml, summary) => {
    const $ = loadNormalized(detailHtml);
    const text = $("#c_text").first().text().replace(/\s+/gu, " ").trim() || $("body").text().replace(/\s+/gu, " ").trim();
    return { url: summary.url, title: summary.title, text, price: prosePrice(text), area: proseArea(text), rooms: proseRooms(text), deposit: proseDeposit(text) };
  }, batches);
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-retkinia-poludnie (WordPress, single page, real table, no price in HTML)
// Real structure confirmed 2026-10-03: a genuine "Zdjęcie / Adres / Opis"
// table lists real open residential tenders ("ustalenie odrębnej własności
// lokalu nr 15 przy al. Wyszyńskiego 70...") with address and area ("80 m²
// w budynku wolnostojącym") -- but no price anywhere in the HTML for any
// row (price is presumably attachment-only). Extracted honestly: price
// stays null and the shared price>0 requirement in toListing() then
// correctly drops these rather than inventing a number the source never
// published.
// ---------------------------------------------------------------------------
async function parseSmRetkiniaPoludnie(html: string, source: OfficialLodzSource): Promise<OfficialSourcePage> {
  const $ = loadNormalized(html);
  const notices: RawNotice[] = [];
  $("h4, h3").each((_, element) => {
    const heading = $(element);
    const title = heading.text().replace(/\s+/gu, " ").trim();
    if (!/przetarg/iu.test(title)) return;
    const table = heading.nextAll("table").first();
    if (!table.length) return;
    table.find("tr").each((__, row) => {
      const cells = $(row).find("td");
      if (cells.length < 3) return;
      const address = $(cells[1]).text().replace(/\s+/gu, " ").trim();
      const description = $(cells[2]).text().replace(/\s+/gu, " ").trim();
      if (!address) return;
      notices.push({ id: textId(`${title}:${address}`), title: `${title} ${address}`, text: `${title} ${address} ${description}`, area: proseArea(description), district: address });
    });
  });
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-radogoszcz-wschod (WordPress, 2-step: list -> detail)
// Real structure confirmed 2026-10-03: list teasers link to full posts
// whose body states a genuinely complete sale notice: "Lokal nr 14, przy
// ul. Sitowie 15A, blok 9, o powierzchni 42,36 m², 2 pokoje, IV piętro.
// Cena wywoławcza wynosi: 259 000,00 zł", plus eligibility criteria and a
// real auction date.
// ---------------------------------------------------------------------------
async function parseSmRadogoszcz(html: string, source: OfficialLodzSource, fetchDetail: FetchText, signal?: AbortSignal, batches?: SourceBatchContext): Promise<OfficialSourcePage> {
  const $ = load(html);
  const summaries: NoticeSummary[] = [];
  $("article a[href*='smrw.pl/']").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    const title = link.text().replace(/\s+/gu, " ").trim();
    if (href && title && !/aktualnosci|kontakt|dokumenty/u.test(href)) summaries.push({ title, url: href });
  });
  const notices = await fetchNoticeDetails(source, summaries, fetchDetail, signal, (detailHtml, summary) => {
    const $ = loadNormalized(detailHtml);
    const text = $(".entry-content").first().text().replace(/\s+/gu, " ").trim() || $("article").first().text().replace(/\s+/gu, " ").trim();
    return { url: summary.url, title: summary.title, text, price: prosePrice(text), area: proseArea(text), rooms: proseRooms(text), deposit: proseDeposit(text), deadline: proseDeadline(text), eventDate: proseEventDate(text), criteria: proseEligibility(text) };
  }, batches);
  return normalizeNotices(source, "cooperative_sale", notices, false);
}

// ---------------------------------------------------------------------------
// sm-doly-marysinska (WordPress blog-category list, 2-step: list -> detail)
// Real structure confirmed 2026-10-03: a paginated category archive; every
// current entry (page 1) is a maintenance/works tender ("roboty
// ogólnobudowlane", "konserwacja instalacji sanitarnych"), excluded by
// title alone, so no detail page is fetched for any of them today -- the
// parser would fetch and extract the moment a residential-sale title
// appears, same selector, same page.
// ---------------------------------------------------------------------------
async function parseSmDolyMarysinska(html: string, source: OfficialLodzSource, fetchDetail: FetchText, signal?: AbortSignal, batches?: SourceBatchContext): Promise<OfficialSourcePage> {
  const $ = load(html);
  const summaries: NoticeSummary[] = [];
  $("article a[href*='smdmlodz.pl/20']").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    const title = link.text().replace(/\s+/gu, " ").trim();
    if (href && title) summaries.push({ title, url: href });
  });
  const notices = await fetchNoticeDetails(source, summaries, fetchDetail, signal, (detailHtml, summary) => {
    const $ = loadNormalized(detailHtml);
    const text = $(".entry-content").first().text().replace(/\s+/gu, " ").trim() || $("article").first().text().replace(/\s+/gu, " ").trim();
    return { url: summary.url, title: summary.title, text, price: prosePrice(text), area: proseArea(text), rooms: proseRooms(text), deposit: proseDeposit(text) };
  }, batches);
  const hasNextPage = Boolean($("a[href*='/category/przetargi/page/']").length);
  return normalizeNotices(source, "cooperative_sale", notices, hasNextPage);
}

// ---------------------------------------------------------------------------
// uml-sale (TYPO3 "Edge Registers" extension, single page, structured table)
// Real structure confirmed 2026-10-03: 67 real current listings, each a
// `article[id^="register-element-"]` accordion item with a genuine
// key/value `<table>` (Powierzchnia wyrażona w m2, Cena wywoławcza (PLN),
// Dzielnica, Struktura mieszkania incl. a literal room-count digit, Data
// przetargu). The richest, most reliable source in the whole catalogue --
// this is a real HTML table, not prose, so it is read as key/value pairs
// rather than through the shared prose regexes.
// ---------------------------------------------------------------------------
async function parseUmlMieszkania(html: string, source: OfficialLodzSource): Promise<OfficialSourcePage> {
  const $ = loadNormalized(html);
  const notices: RawNotice[] = [];
  $("article[id^='register-element-']").each((_, element) => {
    const article = $(element);
    const id = article.attr("id")?.replace("register-element-", "") ?? null;
    const title = article.find(".accordion-item-heading").first().text().replace(/\s+/gu, " ").trim();
    const fields = new Map<string, string>();
    article.find(".accordion--registers--table tr").each((__, row) => {
      const label = $(row).find("td").first().text().replace(/\s+/gu, " ").trim().replace(/:$/u, "");
      const value = $(row).find("td").eq(1).text().replace(/\s+/gu, " ").trim();
      if (label) fields.set(label.toLocaleLowerCase("pl-PL"), value);
    });
    const struktura = fields.get("struktura mieszkania") ?? "";
    notices.push({
      id,
      title,
      text: `${title} ${struktura}`,
      price: fields.get("cena wywoławcza (pln)"),
      area: fields.get("powierzchnia wyrażona w m2"),
      rooms: proseRooms(struktura),
      district: fields.get("dzielnica") ?? null,
      eventDate: fields.get("data przetargu") ?? null,
    });
  });
  return normalizeNotices(source, "municipal_sale", notices, false);
}

// ---------------------------------------------------------------------------
// Blocked sources: the site is wired (so it is never silently dropped from
// the catalogue) but is known, with concrete evidence recorded in
// official-lodz-sources.ts, to be unreachable through a plain read-only GET
// without logging in, solving a CAPTCHA, or executing client-side JS -- all
// of which this project refuses to do. Fails closed: empty listings, one
// clear warning, never a crash and never a fabricated result.
// ---------------------------------------------------------------------------
function parseBlocked(reason: string): OfficialParser {
  return async () => ({ listings: [], hasNextPage: false, warnings: [reason] });
}

// ---------------------------------------------------------------------------
// Shared 2-step (list -> detail) helper for sites whose list page only
// teases a notice (title, maybe a date) and needs its own detail page for
// the real price/area/rooms. Detail pages are fetched only for notices
// whose own title does not already classify as excluded, and capped at 20
// per source per run to keep this within "a few read-only GETs" even for a
// site with a long archive; one broken detail fetch is skipped rather than
// failing the whole source.
// ---------------------------------------------------------------------------
type NoticeSummary = { title: string; url: string };
const MAX_DETAIL_FETCHES = 20;

async function fetchNoticeDetails(source: OfficialLodzSource, summaries: NoticeSummary[], fetchDetail: FetchText, signal: AbortSignal | undefined, extract: (detailHtml: string, summary: NoticeSummary & { url: string }) => RawNotice | null, batches?: SourceBatchContext): Promise<RawNotice[]> {
  const notices: RawNotice[] = [];
  const bounded = summaries.slice(0, MAX_DETAIL_FETCHES);
  for (let index = batches?.cursor ?? 0; index < bounded.length; index += 1) {
    const summary = bounded[index];
    const absolute = absoluteNoticeUrl(summary.url, source.url);
    let notice: RawNotice | null = null;
    const warnings: string[] = [];
    if (absolute && classifyOfficialNotice(summary.title, source) !== "excluded") try {
      const detailHtml = await fetchDetail(absolute, signal);
      notice = extract(detailHtml, { ...summary, url: absolute });
      if (notice) notices.push(notice);
    } catch (error) {
      // Parent timeout/yield is not evidence that a notice has no listings.
      // Keep this detail available for continuation rather than swallowing it.
      if (signal?.aborted) throw error;
      warnings.push(`${source.label}: ${error instanceof Error ? error.message : "detail unavailable"}`);
    }
    if (batches) {
      const parsed = notice ? normalizeNotices(source, "cooperative_sale", [notice], false) : { listings: [], warnings: [] };
      await batches.onBatch({ listings: parsed.listings, warnings: [...warnings, ...parsed.warnings], fetched: parsed.listings.length }, index + 1 < bounded.length ? index + 1 : null);
    }
  }
  return notices;
}

function normalizeNotices(source: OfficialLodzSource, noticeType: OfficialNoticeType, notices: RawNotice[], hasNextPage: boolean): OfficialSourcePage {
  const listings: OfficialSourceListing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const notice of notices) {
    const noticeText = `${notice.title ?? ""} ${notice.text ?? ""}`;
    if (classifyOfficialNotice(noticeText, source) !== "sale_candidate") continue;
    const price = money(notice.price);
    const area = decimal(notice.area);
    const url = absoluteNoticeUrl(notice.url, source.url) ?? source.url;
    const id = notice.id?.trim() || textId(noticeText);
    if (!id || price === null || area === null || area <= 0 || price <= 0 || seen.has(id)) continue;
    seen.add(id);
    const canonicalSource = SOURCE_KIND[source.kind];
    const normalizedUrl = `${normalizeUrl(url)}#${id}`;
    const metadata: OfficialOfferMetadata = { sourceId: source.id, noticeType, priceKind: noticeType === "auction" || noticeType === "syndic_sale" ? "starting_bid" : "asking_price", price, deposit: money(notice.deposit), deadline: cleanDate(notice.deadline), eventDate: cleanDate(notice.eventDate), eligibilityCriteria: notice.criteria ?? [] };
    const payload = { source: canonicalSource, sourceId: source.id, noticeType, id, normalizedUrl, title: notice.title ?? null, price, area, rooms: decimal(notice.rooms), city: notice.city ?? "Łódź", district: notice.district ?? null, officialOffer: metadata };
    const noticeTitle = notice.title?.trim() || `${source.label} — oferta mieszkaniowa`;
    const noticeDescription = notice.text?.trim() || null;
    // eventDate is the auction/tender date, not the date this notice was
    // published. No publication date is claimed unless a source exposes one.
    listings.push({ source: canonicalSource as PropertySource, externalListingId: `${source.id}:${id}`, originalUrl: url, normalizedUrl, title: noticeTitle, price, area, rooms: decimal(notice.rooms), floor: null, pricePerSqm: price / area, city: notice.city ?? "Łódź", district: notice.district ?? null, locationText: [notice.district, notice.city ?? "Łódź"].filter(Boolean).join(", "), thumbnailUrl: validImage(notice.image), images: validImage(notice.image) ? [validImage(notice.image)!] : [], buildingType: extractBuildingType(noticeTitle, noticeDescription), ownership: extractOwnership(noticeTitle, noticeDescription), description: noticeDescription, publishedAt: null, rawPayload: payload, contentHash: calculateContentHash(payload), officialOffer: metadata });
  }
  if (!listings.length) warnings.push(`${source.label}: brak zweryfikowanych ofert mieszkaniowych.`);
  return { listings, hasNextPage, warnings };
}

function absoluteNoticeUrl(value: string | null | undefined, sourceUrl: string): string | null {
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
function cleanDate(value: string | null | undefined): string | null { const result = value?.replace(/\s+/gu, " ").trim(); return result || null; }
function validImage(value: string | null | undefined): string | null { return value && /^https?:\/\//iu.test(value) ? value : null; }
// Deterministic, stable id for notices with no individual URL/sku of their
// own (single-page sites listing several notices inline): a short FNV-1a
// hash of the normalized notice text, so the same real notice always maps
// to the same externalListingId across runs without ever being guessed.
function textId(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
