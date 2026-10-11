import { load } from "cheerio";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { calculateContentHash, extractOtodomListingId, isConfirmedOtodomOfferUrl, normalizeOtodomUrl } from "./otodom-search";
import type { ExternalSourceConfig, ExternalSourceId } from "./external-source-parser";
import { SourceBatchYield, type RadarDetailCursor, type RadarDetailDiagnostic, type SourceBatchContext } from "./source-batches";
import { resolveBuildingType, resolveOwnership } from "./listing-attribute-extraction";
import { invalidSalePriceWarning } from "./sale-price";
import { extractListingIdentityEvidence } from "./identity-evidence";
import { hasCategoryBFinishEvidence, inspectRadarFinishEvidence, isRadarRentalTransactionText, preflightRadarCandidateRejection, resolveKnownRadarDistrict } from "@/features/price-radar/qualification";
import { compareRadarIdentitySnapshots, findRadarOwnListingConflicts } from "@/features/price-radar/own-listing-consistency";

export type ExternalPortalPage = { listings: PropertySourceListing[]; detailCandidates?: PropertySourceListing[]; hasNextPage: boolean; invalidSalePriceCount?: number };
type PortalRecord = Record<string, unknown>;
type PortalCandidate = { id?: unknown; url?: unknown; title?: unknown; description?: unknown; price?: unknown; area?: unknown; rooms?: unknown; floor?: unknown; city?: unknown; district?: unknown; images?: unknown; publishedAt?: unknown; yearBuilt?: unknown; buildingType?: unknown; ownership?: unknown; marketType?: unknown; propertyType?: unknown; sourceRecord?: unknown };
type PortalParser = (html: string, fallbackCity: string) => ExternalPortalPage;

const MAX_PAGES = 5;
const RADAR_DETAIL_PAGE_LIMIT_PER_PORTION = 3;
const RADAR_DETAIL_REQUEST_TIMEOUT_MS = 8_000;
const RADAR_DETAIL_SOURCES = new Set<ExternalSourceId>(["oferty_net", "domiporta", "adresowo", "allegro_lokalnie"]);
type RadarDetailSource = "oferty_net" | "domiporta" | "adresowo" | "allegro_lokalnie" | "otodom";
const TRACKING_PARAM = /^(utm_|fbclid|gclid|dclid|msclkid|yclid|ref$)/iu;

/** Each portal has a separate parser. Only the final canonical mapping is shared. */
export const EXTERNAL_PORTAL_PARSERS: Record<ExternalSourceId, PortalParser> = {
  gratka: parseGratka,
  nieruchomosci_online: parseNieruchomosciOnline,
  domiporta: parseDomiporta,
  sprzedajemy: parseSprzedajemy,
  adresowo: parseAdresowo,
  oferty_net: parseOfertyNet,
  bezposrednio: parseBezposrednio,
  domy: parseDomy,
  allegro_lokalnie: parseAllegroLokalnie,
};

export type ExternalPortalCriteria = { city: string | null; areaMin?: number | null; areaMax?: number | null; rooms?: readonly number[] };

export async function fetchExternalPortal(config: ExternalSourceConfig, criteria: ExternalPortalCriteria, signal?: AbortSignal, batches?: SourceBatchContext): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number; sourceRejectionCounts?: Record<string, number> }> {
  if (batches?.purpose === "price_radar" && RADAR_DETAIL_SOURCES.has(config.id)) {
    return fetchRadarPortalDetails(config as ExternalSourceConfig & { id: Exclude<ExternalSourceId, "gratka" | "nieruchomosci_online" | "sprzedajemy" | "bezposrednio" | "domy"> }, criteria, signal, batches);
  }
  const ofertyLocation = config.id === "oferty_net" && !batches?.ofertyNetLegacySearch ? await resolveOfertyNetLocation(config, criteria.city ?? "", signal) : null;
  const parser = EXTERNAL_PORTAL_PARSERS[config.id];
  const listings: PropertySourceListing[] = [];
  const warnings: string[] = [];
  const sourceRejectionCounts: Record<string, number> = {};
  const seen = new Set<string>();
  let fetched = 0;
  for (let page = batches?.cursor || 1; page <= MAX_PAGES; page += 1) {
    if (signal?.aborted) throw new Error(`${config.label}: request aborted.`);
    const url = pageUrl(config, criteria, page, ofertyLocation, batches?.ofertyNetLegacySearch);
    const response = await fetchExternalPage(url, signal);
    if (!response.ok) throw new Error(`${config.label}: HTTP ${response.status}.`);
    const parsed = parser(await response.text(), criteria.city ?? "");
    const parsedListings = batches?.purpose === "price_radar"
      ? parsed.listings.map((listing) => ({ ...listing, rawPayload: { ...listing.rawPayload, radarSearchScope: "apartment-sale" } }))
      : parsed.listings;
    const pageWarnings = [invalidSalePriceWarning(parsed.invalidSalePriceCount ?? 0)].filter((warning): warning is string => Boolean(warning));
    const invalidSalePriceCount = parsed.invalidSalePriceCount ?? 0;
    if (invalidSalePriceCount > 0) sourceRejectionCounts.invalid_sale_price = (sourceRejectionCounts.invalid_sale_price ?? 0) + invalidSalePriceCount;
    if (parsed.hasNextPage && page === MAX_PAGES) pageWarnings.push(publicSearchPageLimitWarning(config));
    if (batches) {
      await batches.onBatch({ listings: parsedListings, warnings: pageWarnings, fetched: parsed.listings.length + invalidSalePriceCount, ...(invalidSalePriceCount > 0 ? { sourceRejectionCounts: { invalid_sale_price: invalidSalePriceCount } } : {}) }, parsed.hasNextPage && page < MAX_PAGES ? page + 1 : null);
    }
    fetched += parsed.listings.length + invalidSalePriceCount;
    warnings.push(...pageWarnings);
    for (const listing of parsedListings) {
      const identity = `${listing.source}:${listing.externalListingId}:${listing.normalizedUrl}`;
      if (!seen.has(identity)) { seen.add(identity); listings.push(listing); }
    }
    if (!parsed.hasNextPage) break;
  }
  if (!listings.length) warnings.push(`${config.label}: odpowiedź nie zawiera zweryfikowanych ofert sprzedaży.`);
  return { listings, warnings: [...new Set(warnings)], fetched, ...(Object.keys(sourceRejectionCounts).length ? { sourceRejectionCounts } : {}) };
}

async function fetchRadarPortalDetails(config: ExternalSourceConfig, criteria: ExternalPortalCriteria, signal: AbortSignal | undefined, batches: SourceBatchContext): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  const cursor: RadarDetailCursor = batches.radarDetailCursor ?? { kind: "radar_detail_v1", page: batches.cursor ?? 1, candidateIndex: 0 };
  if (isRetryAfterPending(cursor)) throw new SourceBatchYield("detail_rate_limit");
  const parser = EXTERNAL_PORTAL_PARSERS[config.id];
  const city = criteria.city ?? "";
  const ofertyLocation = config.id === "oferty_net" && !batches.ofertyNetLegacySearch ? await resolveOfertyNetLocation(config, city, signal) : null;
  const listings: PropertySourceListing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  let detailPagesThisPortion = 0;
  let sawCandidates = false;

  for (let page = cursor.page; page <= MAX_PAGES; page += 1) {
    if (signal?.aborted) throw new Error(`${config.label}: request aborted.`);
    const pageUrlValue = pageUrl(config, criteria, page, ofertyLocation, batches.ofertyNetLegacySearch);
    const pageResponse = await fetchExternalPage(pageUrlValue, signal);
    if (!pageResponse.ok) throw new Error(`${config.label}: HTTP ${pageResponse.status}.`);
    const pageHtml = await pageResponse.text();
    assertNotAccessChallenge(config.label, pageHtml);
    const parsed = parser(pageHtml, city);
    const candidates = parsed.detailCandidates ?? parsed.listings;
    sawCandidates ||= candidates.length > 0;
    const firstIndex = page === cursor.page ? cursor.candidateIndex : 0;

    if (candidates.length === 0) {
      const next = parsed.hasNextPage && page < MAX_PAGES ? radarDetailCursor(page + 1, 0) : null;
      const pageWarnings = parsed.hasNextPage && page === MAX_PAGES ? [publicSearchPageLimitWarning(config)] : [];
      warnings.push(...pageWarnings);
      await batches.onBatch({ listings: [], warnings: pageWarnings, fetched: 0 }, next);
      if (!next) break;
      continue;
    }

    for (let candidateIndex = firstIndex; candidateIndex < candidates.length; candidateIndex += 1) {
      if (signal?.aborted) throw new Error(`${config.label}: request aborted.`);
      if (batches.deadlineAt && Date.now() + RADAR_DETAIL_REQUEST_TIMEOUT_MS >= batches.deadlineAt) {
        throw new SourceBatchYield("portion_budget");
      }
      const sourceCandidate = candidates[candidateIndex]!;
      const baseListing = { ...sourceCandidate, rawPayload: { ...sourceCandidate.rawPayload, radarSearchScope: "apartment-sale" } };
      const next = candidateIndex + 1 < candidates.length
        ? radarDetailCursor(page, candidateIndex + 1)
        : parsed.hasNextPage && page < MAX_PAGES ? radarDetailCursor(page + 1, 0) : null;
      const candidateWarnings = parsed.hasNextPage && page === MAX_PAGES && candidateIndex === candidates.length - 1
        ? [publicSearchPageLimitWarning(config)] : [];
      const result = await processRadarDetailCandidate(config.id as RadarDetailSource, config.label, baseListing, page, candidateIndex, next, signal, batches, candidateWarnings);
      fetched += result.batch.fetched;
      warnings.push(...result.batch.warnings);
      if (result.listing) {
        const identity = `${result.listing.source}:${result.listing.externalListingId}:${result.listing.normalizedUrl}`;
        if (!seen.has(identity)) { seen.add(identity); listings.push(result.listing); }
      }
      await batches.onBatch(result.batch, result.nextCursor);
      if (result.detailFetched) detailPagesThisPortion += 1;
      if (detailPagesThisPortion >= RADAR_DETAIL_PAGE_LIMIT_PER_PORTION && next !== null) {
        throw new SourceBatchYield("detail_batch_limit");
      }
    }

    if (!parsed.hasNextPage || page >= MAX_PAGES) break;
  }

  if (!sawCandidates) warnings.push(`${config.label}: brak ofert z prawidłowym adresem szczegółów.`);
  return { listings, warnings: [...new Set(warnings)], fetched };
}

export async function fetchRadarOtodomDetails(candidates: readonly PropertySourceListing[], signal: AbortSignal | undefined, batches: SourceBatchContext): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  const cursor = batches.radarDetailCursor ?? { kind: "radar_detail_v1" as const, page: 1, candidateIndex: 0 };
  if (isRetryAfterPending(cursor)) throw new SourceBatchYield("detail_rate_limit");
  if (cursor.page > 1 || cursor.candidateIndex >= candidates.length) {
    await batches.onBatch({ listings: [], warnings: [], fetched: 0 }, null);
    return { listings: [], warnings: [], fetched: 0 };
  }
  const listings: PropertySourceListing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  let detailPagesThisPortion = 0;
  for (let candidateIndex = cursor.candidateIndex; candidateIndex < candidates.length; candidateIndex += 1) {
    if (signal?.aborted) throw new Error("Otodom: request aborted.");
    if (batches.deadlineAt && Date.now() + RADAR_DETAIL_REQUEST_TIMEOUT_MS >= batches.deadlineAt) throw new SourceBatchYield("portion_budget");
    const next = candidateIndex + 1 < candidates.length ? radarDetailCursor(1, candidateIndex + 1) : null;
    const result = await processRadarDetailCandidate("otodom", "Otodom", candidates[candidateIndex]!, 1, candidateIndex, next, signal, batches);
    fetched += result.batch.fetched;
    warnings.push(...result.batch.warnings);
    if (result.listing) {
      const key = `${result.listing.source}:${result.listing.externalListingId}:${result.listing.normalizedUrl}`;
      if (!seen.has(key)) { seen.add(key); listings.push(result.listing); }
    }
    await batches.onBatch(result.batch, result.nextCursor);
    if (result.detailFetched) detailPagesThisPortion += 1;
    if (detailPagesThisPortion >= RADAR_DETAIL_PAGE_LIMIT_PER_PORTION && next !== null) throw new SourceBatchYield("detail_batch_limit");
  }
  return { listings, warnings: [...new Set(warnings)], fetched };
}

async function processRadarDetailCandidate(source: RadarDetailSource, label: string, base: PropertySourceListing, page: number, candidateIndex: number, nextCursor: RadarDetailCursor | null, signal: AbortSignal | undefined, batches: SourceBatchContext, warnings: string[] = []): Promise<{ batch: import("./source-batches").SourceBatch; nextCursor: RadarDetailCursor | null; listing: PropertySourceListing | null; detailFetched: boolean }> {
  const savedCursor = batches.radarDetailCursor;
  const isSameCursor = savedCursor?.page === page && savedCursor.candidateIndex === candidateIndex;
  const currentCursor: RadarDetailCursor = isSameCursor ? { ...savedCursor } : radarDetailCursor(page, candidateIndex);
  const retryAfterUntil = currentCursor.retryAfterUntil ? Date.parse(currentCursor.retryAfterUntil) : null;
  if (retryAfterUntil !== null && Number.isFinite(retryAfterUntil) && retryAfterUntil > Date.now()) {
    throw new SourceBatchYield("detail_rate_limit");
  }
  const propertyType = typeof base.rawPayload.propertyType === "string" ? base.rawPayload.propertyType : null;
  const rejection = preflightRadarCandidateRejection({ title: base.title, description: base.description, buildingType: base.buildingType, propertyType, rawPayload: base.rawPayload });
  if (rejection) return { batch: { listings: [], warnings, fetched: 1, rejectionReasons: [rejection] }, nextCursor, listing: null, detailFetched: false };

  const detailUrl = radarDetailUrl(source, base.originalUrl);
  if (!detailUrl) {
    return {
      batch: { listings: [], warnings: [...warnings, `DETAIL_URL_INVALID:${base.externalListingId}`], fetched: 1, diagnostics: [{ kind: "detail_fetch_failed", listingUrl: base.originalUrl || null, finalUrl: null, httpStatus: null, identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: "INVALID_DETAIL_URL" }] },
      nextCursor, listing: null, detailFetched: false,
    };
  }

  let response: Response;
  try {
    response = await fetchExternalPage(detailUrl, signal, RADAR_DETAIL_REQUEST_TIMEOUT_MS, false);
  } catch (error) {
    const diagnostic: RadarDetailDiagnostic = { kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl: null, httpStatus: null, identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: isTimeoutError(error) ? "TIMEOUT" : "NETWORK_ERROR" };
    await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [diagnostic] }, currentCursor);
    throw error;
  }
  const finalUrl = response.url || detailUrl;
  if (response.status === 429) {
    const retryAttempt = currentCursor.retryAttempt ?? 0;
    const diagnostic: RadarDetailDiagnostic = { kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl, httpStatus: 429, identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: "RATE_LIMITED" };
    if (retryAttempt >= 1) {
      await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [diagnostic] }, currentCursor);
      throw new Error(`${label}: HTTP 429 (detail retry exhausted).`);
    }
    const retryCursor: RadarDetailCursor = {
      ...radarDetailCursor(page, candidateIndex),
      retryAttempt: 1,
      retryAfterUntil: retryAfterDate(response.headers.get("retry-after"), Date.now()).toISOString(),
    };
    await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [diagnostic] }, retryCursor);
    throw new SourceBatchYield("detail_rate_limit");
  }
  if (response.status === 404 || response.status === 410) {
    const diagnostic: RadarDetailDiagnostic = { kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity: "unconfirmed", unconfirmedFields: [], contradictoryFields: [], errorCode: response.status === 404 ? "NOT_FOUND" : "GONE" };
    return { batch: { listings: [], warnings, fetched: 1, diagnostics: [diagnostic] }, nextCursor, listing: null, detailFetched: true };
  }
  if (!response.ok) {
    const diagnostic: RadarDetailDiagnostic = { kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: "HTTP_ERROR" };
    await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [diagnostic] }, currentCursor);
    throw new Error(`${label}: HTTP ${response.status} (detail).`);
  }
  const html = await response.text();
  try {
    assertNotAccessChallenge(label, html);
  } catch (error) {
    const diagnostic: RadarDetailDiagnostic = { kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: "ACCESS_CHALLENGE" };
    await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [diagnostic] }, currentCursor);
    throw error;
  }
  const detail = parseRadarOfferDetail(source, html, detailUrl);
  const identity = compareRadarDetailIdentity(source, base, detailUrl, finalUrl);
  let listing: PropertySourceListing | null = null;
  let diagnostic: RadarDetailDiagnostic | undefined;
  if (identity === "mismatch") {
    diagnostic = { kind: "detail_identity_mismatch", listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity, unconfirmedFields: ["identity"], contradictoryFields: ["identity"] };
    listing = withUnconfirmedRadarDetail(base, ["identity"]);
  } else if (identity === "unconfirmed" || identity === "not_checked") {
    diagnostic = { kind: "detail_not_confirmed", listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity, unconfirmedFields: ["identity"], contradictoryFields: [] };
    listing = withUnconfirmedRadarDetail(base);
  } else {
    const conflicts = compareRadarIdentitySnapshots(
      { area: base.area, rooms: base.rooms, floor: parseFloor(base.floor), locationText: base.locationText, price: base.price },
      { area: detail.area, rooms: detail.rooms, floor: detail.floor, locationText: detail.locationText, price: detail.price },
    );
    const resolvedDetail = { ...detail, contradictoryFields: [...new Set([...detail.contradictoryFields, ...conflicts])], verified: detail.verified && conflicts.length === 0 };
    if (resolvedDetail.active) listing = mergeRadarDetail(base, resolvedDetail, { listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity });
    if (!resolvedDetail.verified || resolvedDetail.unconfirmedFields.length > 0 || resolvedDetail.contradictoryFields.length > 0) {
      diagnostic = { kind: "detail_not_confirmed", listingUrl: detailUrl, finalUrl, httpStatus: response.status, identity, unconfirmedFields: resolvedDetail.unconfirmedFields, contradictoryFields: resolvedDetail.contradictoryFields };
    }
  }
  return { batch: { listings: listing ? [listing] : [], warnings, fetched: 1, ...(diagnostic ? { diagnostics: [diagnostic] } : {}) }, nextCursor, listing, detailFetched: true };
}

function radarDetailUrl(source: RadarDetailSource, value: string | null): string | null {
  if (!value) return null;
  if (source === "otodom") return isConfirmedOtodomOfferUrl(value) ? normalizeOtodomUrl(value) : null;
  return absoluteUrl(value, source);
}

function radarDetailCursor(page: number, candidateIndex: number): RadarDetailCursor {
  return { kind: "radar_detail_v1", page, candidateIndex };
}

function isRetryAfterPending(cursor: RadarDetailCursor): boolean {
  const retryAt = cursor.retryAfterUntil ? Date.parse(cursor.retryAfterUntil) : NaN;
  return Number.isFinite(retryAt) && retryAt > Date.now();
}

async function fetchExternalPage(url: string, signal?: AbortSignal, timeoutMs = 20_000, retryServerErrors = true): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) throw new Error("external source request aborted.");
    response = await fetch(url, { cache: "no-store", headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "User-Agent": "FlipManager/1.0" }, redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (!retryServerErrors || (response.status !== 429 && response.status < 500) || attempt === 2) return response;
    await retryDelay(attempt, signal);
  }
  if (!response) throw new Error("external source request did not return a response.");
  return response;
}

function retryAfterDate(value: string | null, now: number): Date {
  if (value) {
    const seconds = Number(value.trim());
    const parsed = Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(Math.max(now + 1_000, parsed));
  }
  return new Date(now + 60_000);
}

async function retryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 150 * 2 ** (attempt - 1));
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("external source request aborted.")); }, { once: true });
  });
}

type ParsedRadarPortalDetail = {
  active: boolean;
  verified: boolean;
  unconfirmedFields: string[];
  contradictoryFields: string[];
  price: number | null;
  area: number | null;
  rooms: number | null;
  floor: number | null;
  yearBuilt: number | null;
  city: string | null;
  district: string | null;
  locationText: string | null;
  buildingType: string | null;
  marketType: "primary" | "secondary" | null;
  propertyType: "apartment" | null;
  description: string | null;
};

/**
 * Parses only the two existing portal adapters that need detail-page evidence
 * for Radar qualification. The result-list parser remains the single source
 * of candidate IDs/URLs; this parser never discovers or crawls new pages.
 */
export function parseRadarOfferDetail(source: RadarDetailSource, html: string, offerUrl?: string): ParsedRadarPortalDetail {
  if (source === "adresowo") return parseAdresowoRadarDetail(html);
  if (source === "allegro_lokalnie") return parseAllegroRadarDetail(html);
  if (source === "otodom") return parseOtodomRadarDetail(html);
  if (source === "domiporta") return parseDomiportaRadarDetail(html, offerUrl ?? "");
  const $ = load(html);
  const fieldValues = new Map<string, string>();
  const fields = source === "oferty_net" ? $(".param dt") : $(".features__item_name");
  fields.each((_, element) => {
    const label = normalizeDetailLabel($(element).text());
    const value = $(element).next("dd, .features__item_value").text().replace(/\s+/gu, " ").trim();
    if (label && value) fieldValues.set(label, value);
  });

  const textByLabels = (aliases: string[]): string | null => {
    for (const alias of aliases) {
      const value = fieldValues.get(normalizeDetailLabel(alias));
      if (value) return value;
    }
    return null;
  };
  const headline = source === "oferty_net" ? $(".header h3").first().text() : $(".summary__price_number").first().text();
  const explicitPrice = source === "oferty_net"
    ? headline.match(/\bCena\s*:\s*([\d\s\u00a0.,]+)\s*(?:PLN|zł)\b/iu)?.[1]
    : $(".summary__price_number [itemprop='price']").first().attr("content") ?? headline;
  const price = explicitPrice ? money(explicitPrice) : null;
  const areaText = textByLabels(["Powierzchnia użytkowa", "Powierzchnia mieszkalna", "Powierzchnia całkowita", "Powierzchnia"]);
  const area = areaText ? decimal(areaFromText(areaText) ?? areaText) : null;
  const roomsText = textByLabels(["Liczba pokoi", "Pokoje"]);
  const rooms = roomsText ? decimal(roomsText.match(/\d+(?:[.,]\d+)?/u)?.[0] ?? roomsText) : null;
  const floorText = textByLabels(["Piętro", "Kondygnacja", "Poziom"]);
  const floor = parseFloor(floorText);
  const yearBuiltText = textByLabels(["Rok budowy"]);
  const yearBuilt = yearBuiltText ? parseExplicitConstructionYear(yearBuiltText) : null;
  const location = source === "oferty_net" ? $(".header h1").first().text() : $(".summary__location").first().text();
  const locationText = location.replace(/\s+/gu, " ").trim() || null;
  const { city, district } = parseRadarLocation(location);
  const titleText = [$("title").first().text(), $("h1").first().text(), source === "oferty_net" ? $(".header span").first().text() : ""].join(" ");
  const detailDescription = $(".description, .offer_description, .offer-description, [itemprop='description']").first().text();

  const buildingType = textByLabels(["Typ budynku", "Rodzaj budynku", "Rodzaj zabudowy"])
    ?? resolveBuildingType(null, titleText, detailDescription);
  const primaryMarket = textByLabels(["Rynek pierwotny"]);
  const marketLabel = textByLabels(["Rynek"]);
  const marketType = parseMarketType(primaryMarket, marketLabel) ?? parseMarketType(null, `${titleText} ${detailDescription ?? ""}`);
  const propertyType = /mieszkan\p{L}*/iu.test(titleText) && /sprzed\p{L}*/iu.test(titleText) ? "apartment" : null;
  const conditionLabel = textByLabels(["Stan nieruchomości", "Stan mieszkania", "Stan wykończenia", "Standard wykończenia"]);
  const description = [detailDescription, conditionLabel ? `Stan nieruchomości: ${conditionLabel}` : null].map((value) => value?.replace(/\s+/gu, " ").trim()).filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index).join(" ") || null;
  const pageText = `${titleText} ${description ?? ""} ${$(".archive__title, .archive").text()}`;
  const active = !$(".archive, .archive__title").length && !/ogłoszenie\s+(?:jest\s+)?już\s+nieaktualne|oferta\s+nieaktualna|archiwum\s+domiporta/iu.test(pageText);
  const finishText = `${conditionLabel ?? ""} ${description ?? ""}`;
  const finish = inspectRadarFinishEvidence(finishText);
  const categoryBFinishConfirmed = marketType === "secondary" && hasCategoryBFinishEvidence(titleText, description);
  const normalizedFinishText = normalizeDetailLabel(finishText);
  const unfinishedEvidence = /stan deweloperski|do wykonczenia|do remontu|wymaga remontu/u.test(normalizedFinishText);
  // Detail verification means the source explicitly states a finish/condition
  // fact. Qualification still decides whether that fact meets Radar's stricter
  // market-specific renovation/turnkey rules.
  const finishStatusConfirmed = finish.fullRenovation || finish.turnkey || unfinishedEvidence || hasCategoryBFinishEvidence(titleText, description);
  const unconfirmedFields: string[] = [];
  const contradictoryFields: string[] = [];
  if (price === null || price <= 0) unconfirmedFields.push("total_price");
  if (area === null || area <= 0) unconfirmedFields.push("area");
  if (city === null) unconfirmedFields.push("city_lodz");
  if (!district) unconfirmedFields.push("district");
  if (!buildingType) unconfirmedFields.push("building_type");
  else if (!["blok", "apartamentowiec"].includes(normalizeDetailLabel(buildingType))) contradictoryFields.push("building_type");
  const normalizedMarketText = normalizeDetailLabel(`${primaryMarket ?? ""} ${marketLabel ?? ""} ${titleText} ${detailDescription ?? ""}`);
  const primaryEvidence = /rynek pierwotny|od dewelopera|nowa inwestycja|inwestycja deweloperska/u.test(normalizedMarketText);
  const secondaryEvidence = /rynek wtorny/u.test(normalizedMarketText);
  if (primaryEvidence && secondaryEvidence) contradictoryFields.push("market_type");
  else if (!marketType) unconfirmedFields.push("market_type");
  if (propertyType !== "apartment") {
    const normalizedTitle = normalizeDetailLabel(titleText);
    (/(?:na|do) wynaj|czynsz najmu|dom|dzialk|lokal uzytkow/iu.test(normalizedTitle) ? contradictoryFields : unconfirmedFields).push("apartment_sale");
  }
  const positiveFinishEvidence = finish.fullRenovation || finish.turnkey || finish.freshFullRenovation || finish.moveInReady;
  if (positiveFinishEvidence && unfinishedEvidence) contradictoryFields.push("finish_evidence");
  else if (marketType === "secondary" && !categoryBFinishConfirmed) {
    if (!finish.fullRenovation) unconfirmedFields.push("renovation_completion");
    if (!finish.freshFullRenovation) unconfirmedFields.push("renovation_recency");
    if (!finish.moveInReady) unconfirmedFields.push("move_in_readiness");
  } else if (marketType === "primary" && !finish.turnkey) unconfirmedFields.push("turnkey_finish");
  else if (!marketType && !positiveFinishEvidence) unconfirmedFields.push("finish_evidence");
  if (!active) contradictoryFields.push("active_listing");
  contradictoryFields.push(...findRadarOwnListingConflicts({ area, rooms, floor, locationText, title: titleText, description }));
  // District is the only field allowed to remain unresolved for the operator
  // queue. The collector re-runs qualification with a temporary district
  // probe and queues the candidate only if every other rule passes.
  const verified = active && price !== null && price > 0 && area !== null && area > 0 && city === "Łódź" && Boolean(buildingType) && Boolean(marketType) && propertyType === "apartment" && finishStatusConfirmed && contradictoryFields.length === 0;
  return { active, verified, unconfirmedFields, contradictoryFields: [...new Set(contradictoryFields)], price, area, rooms, floor, yearBuilt, city, district, locationText, buildingType, marketType, propertyType, description };
}

function parseAdresowoRadarDetail(html: string): ParsedRadarPortalDetail {
  const $ = load(html);
  const records = jsonLdRecords(html);
  const place = records.find((record) => hasType(record, "Place")) ?? {};
  const canonical = $("link[rel='canonical']").attr("href") ?? "";
  const offer = records.find((record) => hasType(record, "Offer") && (!canonical || !text(record, "url") || canonicalDetailUrl(text(record, "url")!) === canonicalDetailUrl(canonical)))
    ?? records.find((record) => hasType(record, "Offer")) ?? {};
  const titleText = [$("title").first().text(), $("h1").first().text(), text(place, "name")].filter(Boolean).join(" ");
  const metaDescription = decodeDetailText($("meta[name='description']").attr("content") ?? "");
  const description = stripHtml(text(place, "description") ?? $(".offer-description, .description, [data-testid='offer-description']").first().text()) || null;
  const placeAddress = atPath(place, ["address"]);
  const locationText = (isRecord(placeAddress) ? text(placeAddress, "streetAddress") : null) ?? text(place, "name") ?? $("h1").first().text();
  const parsedLocation = parseRadarLocation(locationText);
  const city = parsedLocation.city;
  const district = parsedLocation.district;
  const explicitMarket = labeledDetailValue($, ["rynek", "rynek pierwotny"]);
  const marketType = parseMarketType(explicitMarket, `${explicitMarket ?? ""} ${titleText} ${description ?? ""}`);
  const area = decimal(areaFromText(metaDescription) ?? areaFromText(text(place, "name")) ?? areaFromText(titleText));
  const rooms = decimal(roomsFromText(metaDescription) ?? roomsFromText(text(place, "name")) ?? roomsFromText(titleText));
  const floor = parseFloor(metaDescription) ?? parseFloor(text(place, "name"));
  const price = portalMoney(offer.price ?? offer.lowPrice);
  const buildingType = normalizePortalBuildingType(labeledDetailValue($, ["typ budynku", "rodzaj budynku"]), titleText, `${metaDescription} ${description ?? ""}`);
  const active = !/og\u0142oszenie\s+(?:jest\s+)?ju\u017c\s+nieaktualne|oferta\s+nieaktualna|og\u0142oszenie\s+zako\u0144czone/iu.test($("main").text());
  const propertyType = /mieszkan\p{L}*/iu.test(titleText) && /sprzed\p{L}*/iu.test(titleText) ? "apartment" : null;
  const yearBuilt = parseExplicitConstructionYear(labeledDetailValue($, ["rok budowy"]) ?? "");
  return buildRadarDetail({ source: "adresowo", active, titleText, description, price, area, rooms, floor, yearBuilt, city, district, locationText, buildingType, marketType, propertyType, explicitMarket, areaLabel: metaDescription });
}

function parseDomiportaRadarDetail(html: string, offerUrl: string): ParsedRadarPortalDetail {
  const $ = load(html);
  const targetId = offerUrl.match(/(?:_|-|\/)(\d+)(?:[/?#]|$)/u)?.[1] ?? null;
  const targetPath = canonicalDetailUrl(offerUrl);
  const records = jsonLdRecords(html);
  const structured = records.find((record) => {
    if (!hasType(record, "Offer", "Product", "RealEstateListing", "Residence", "Apartment")) return false;
    const url = text(record, "url") ?? text(record, "@id");
    const identifier = typeof record.identifier === "string" ? record.identifier : isRecord(record.identifier) ? text(record.identifier, "value") : null;
    return Boolean((url && canonicalDetailUrl(url) === targetPath) || (targetId && identifier === targetId));
  }) ?? null;
  const offer = isRecord(structured?.offers) ? structured.offers : {};
  const unit = isRecord(offer.itemOffered) ? offer.itemOffered
    : isRecord(structured?.itemOffered) ? structured.itemOffered
      : structured ?? {};
  const unitRoot = targetId ? $(`[data-offer-id="${targetId}"], [data-listing-id="${targetId}"], [data-unit-id="${targetId}"], [data-apartment-id="${targetId}"]`).first() : null;
  const root = unitRoot?.length ? unitRoot : $("main").first().length ? $("main").first() : $("body");
  const titleText = [$("title").first().text(), root.find("h1").first().text() || $("h1").first().text(), text(structured ?? {}, "name")].filter(Boolean).join(" ");
  const description = stripHtml(text(unit, "description") ?? text(structured ?? {}, "description") ?? root.find(".description__container, .description, [itemprop='description']").first().text()) || null;
  const fieldValues = new Map<string, string>();
  root.find(".features__item_name, dt, [data-field-label]").each((_, element) => {
    const labelElement = $(element);
    const label = normalizeDetailLabel(labelElement.attr("data-field-label") ?? labelElement.text());
    const value = labelElement.next("dd, .features__item_value").text().replace(/\s+/gu, " ").trim()
      || labelElement.closest(".features__item, [data-field]").find(".features__item_value, [data-field-value]").first().text().replace(/\s+/gu, " ").trim();
    if (label && value) fieldValues.set(label, value);
  });
  const field = (...labels: string[]) => labels.map((label) => fieldValues.get(normalizeDetailLabel(label))).find(Boolean) ?? null;
  const priceText = (typeof offer.price === "string" || typeof offer.price === "number" ? String(offer.price) : null)
    ?? (typeof structured?.price === "string" || typeof structured?.price === "number" ? String(structured.price) : null)
    ?? root.find(".summary__price_number [itemprop='price']").first().attr("content")
    ?? root.find(".summary__price_number, [data-price], [itemprop='price']").first().attr("data-price")
    ?? root.find(".summary__price_number").first().text()
    ?? field("Cena", "Cena całkowita")
    ?? $("meta[property='product:price:amount']").attr("content") ?? "";
  const price = money(priceText);
  const areaValue = atPath(unit, ["floorSize", "value"]) ?? unit.area;
  const areaText = (typeof areaValue === "number" ? String(areaValue) : stringValue(areaValue))
    ?? field("Powierzchnia", "Powierzchnia użytkowa", "Metraż")
    ?? root.find("[itemprop='floorSize']").first().attr("content") ?? "";
  const area = decimal(areaFromText(areaText) ?? areaText) ?? decimal(areaFromText(titleText));
  const roomsValue = unit.numberOfRooms ?? unit.rooms;
  const rooms = decimal(roomsValue) ?? decimal((field("Liczba pokoi", "Pokoje") ?? "").match(/\d+(?:[.,]\d+)?/u)?.[0] ?? roomsFromText(titleText));
  const floor = parseFloor(stringValue(unit.floorLevel) ?? field("Piętro", "Kondygnacja"));
  const addressValue = isRecord(unit.address) ? unit.address : structured?.address;
  const address = isRecord(addressValue) ? addressValue : {};
  const locationText = [text(address, "addressLocality"), text(address, "addressSuburb"), text(address, "addressRegion"), text(address, "streetAddress"), field("Lokalizacja", "Adres"), root.find(".summary__location, [data-testid='offer-location']").first().text()].filter(Boolean).join(", ");
  const parsedLocation = parseRadarLocation(locationText || titleText);
  const city = parsedLocation.city;
  const district = parsedLocation.district;
  const explicitMarket = stringValue(unit.marketType) ?? stringValue(structured?.marketType) ?? field("Rynek", "Rynek pierwotny");
  const marketType = parseMarketType(explicitMarket, `${explicitMarket ?? ""} ${titleText} ${description ?? ""}`);
  const buildingType = normalizePortalBuildingType(stringValue(unit.buildingType) ?? field("Typ budynku", "Rodzaj budynku", "Rodzaj zabudowy"), titleText, description);
  const saleEvidence = `${titleText} ${description ?? ""} ${root.text()}`;
  const propertyType = (hasType(unit, "Apartment", "Residence") || /mieszkan\p{L}*/iu.test(saleEvidence))
    && /na sprzedaż|sprzedam|sprzedaż mieszkań/iu.test(`${titleText} ${description ?? ""}`)
    && !isRadarRentalTransactionText(`${titleText} ${description ?? ""}`) ? "apartment" : null;
  const active = Boolean(root.find("h1").length || $("h1").length) && !/ogłoszenie\s+(?:jest\s+)?już\s+nieaktualne|oferta\s+nieaktualna|archiwum/iu.test($("body").text());
  const yearBuilt = parseExplicitConstructionYear(field("Rok budowy") ?? "");
  return buildRadarDetail({ source: "domiporta", active, titleText, description, price, area, rooms, floor, yearBuilt, city, district, locationText: locationText || null, buildingType, marketType, propertyType, explicitMarket, areaLabel: areaText });
}

function parseAllegroRadarDetail(html: string): ParsedRadarPortalDetail {
  const $ = load(html);
  const canonical = $("link[rel='canonical']").attr("href") ?? "";
  const canonicalPath = canonicalDetailUrl(canonical);
  const product = jsonLdRecords(html).find((record) => hasType(record, "Product", "Apartment", "Residence") && (!text(record, "url") || canonicalDetailUrl(text(record, "url")!) === canonicalPath)) ?? {};
  const titleText = [$("title").first().text(), $("h1").first().text(), text(product, "name")].filter(Boolean).join(" ");
  const metaDescription = decodeDetailText($("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content") ?? "");
  const fieldValues = new Map<string, string>();
  $("tr.mlc-params__parameter, li.mlc-itembox__params__param, [data-testid='offer-parameter']").each((_, row) => {
    const rowElement = $(row);
    const name = normalizeDetailLabel(rowElement.find(".mlc-params__parameter-name, .mlc-itembox__params__param__name, [data-testid='parameter-name']").first().text() || rowElement.attr("data-label") || rowElement.clone().children().remove().end().text().split(":")[0]);
    const value = (rowElement.find(".mlc-params__parameter-value, .mlc-itembox__params__param__name, [data-testid='parameter-value']").last().text()
      || rowElement.text().replace(/^\s*[^:]+:\s*/u, "")).replace(/\s+/gu, " ").trim();
    if (name && value) fieldValues.set(name, value);
  });
  const field = (...labels: string[]) => labels.map((label) => fieldValues.get(normalizeDetailLabel(label))).find(Boolean) ?? null;
  const description = stripHtml($(".ml-text-truncate__content, [data-testid='offer-description'], [itemprop='description']").first().text() || text(product, "description") || metaDescription) || null;
  const locationText = $("[data-testid='offer-location'], .mlc-itembox__location, h1").first().text().replace(/\s+/gu, " ").trim() || titleText;
  const { city, district } = parseRadarLocation(locationText);
  const area = decimal(areaFromText(field("Powierzchnia") ?? "") ?? areaFromText(titleText));
  const rooms = decimal((field("Liczba pokoi") ?? "").match(/\d+(?:[.,]\d+)?/u)?.[0] ?? roomsFromText(titleText));
  const floor = parseFloor(field("Piętro"));
  const offers = isRecord(product.offers) ? product.offers : {};
  const priceText = field("Cena", "Cena całkowita")
    ?? $("meta[property='product:price:amount'], meta[itemprop='price']").first().attr("content")
    ?? (typeof offers.price === "string" || typeof offers.price === "number" ? String(offers.price) : null)
    ?? metaDescription.match(/(?:^|\s)(?:za|cena)\s+([\d\s.,]+)\s*(?:zł|pln)(?!\s*\/\s*m)/iu)?.[1]
    ?? "";
  const price = money(priceText);
  const explicitMarket = field("Rynek", "Rynek pierwotny") ?? (/(?:rynek\s+wtórny|rynek\s+pierwotny)/iu.test(metaDescription) ? metaDescription : null);
  const marketType = parseMarketType(explicitMarket, `${explicitMarket ?? ""} ${metaDescription}`);
  const buildingType = normalizePortalBuildingType(field("Typ budynku"), titleText, description);
  const pageText = $("main").text() || $("body").text();
  const active = Boolean($("h1").length) && !/og\u0142oszenie\s+(?:jest\s+)?zako\u0144czone|oferta\s+nieaktualna|przedmiot\s+nie\s+jest\s+dost\u0119pny/iu.test(pageText);
  const saleEvidence = `${titleText} ${metaDescription} ${field("Transakcja", "Rodzaj oferty", "Kategoria") ?? ""}`;
  const propertyType = /mieszkan\p{L}*/iu.test(saleEvidence) && /sprzed\p{L}*/iu.test(saleEvidence) && !isRadarRentalTransactionText(saleEvidence) ? "apartment" : null;
  const yearBuilt = parseExplicitConstructionYear(field("Rok budowy") ?? "");
  return buildRadarDetail({ source: "allegro_lokalnie", active, titleText, description, price, area, rooms, floor, yearBuilt, city, district, locationText, buildingType, marketType, propertyType, explicitMarket, areaLabel: field("Powierzchnia") });
}

function parseOtodomRadarDetail(html: string): ParsedRadarPortalDetail {
  const $ = load(html);
  const next = nextData(html);
  const pageProps = atPath(next, ["props", "pageProps"]);
  const adValue = isRecord(pageProps) ? pageProps.ad : null;
  const unifiedValue = isRecord(pageProps) ? pageProps.unifiedAd : null;
  const ad = isRecord(adValue) ? adValue : {};
  const unified = isRecord(unifiedValue) ? unifiedValue : {};
  const attributes = isRecord(ad.attributes) ? ad.attributes : {};
  const category = isRecord(ad.adCategory) ? ad.adCategory : {};
  const addressValue = atPath(ad, ["location", "address"]);
  const unifiedAddressValue = atPath(unified, ["location", "address"]);
  const address = isRecord(addressValue) ? addressValue : isRecord(unifiedAddressValue) ? unifiedAddressValue : {};
  const street = nestedName(address.street);
  const subdistrict = nestedName(address.subdistrict);
  const namedDistrict = nestedName(address.district);
  const namedCity = nestedName(address.city);
  const titleText = [$("title").first().text(), $("h1").first().text(), text(ad, "title"), text(unified, "title")].filter(Boolean).join(" ");
  const description = stripHtml(text(unified, "description") ?? text(ad, "description") ?? "") || null;
  const locationText = [namedCity, namedDistrict, subdistrict, street, $("h1").first().text()].filter(Boolean).join(", ");
  const parsedLocation = parseRadarLocation(`${locationText} ${titleText}`);
  const city = namedCity ? parseRadarLocation(namedCity).city ?? (/\u0141\u00f3d\u017a/iu.test(namedCity) ? "Łódź" : null) : parsedLocation.city;
  const district = namedDistrict ? parseRadarLocation(namedDistrict).district ?? resolveKnownRadarDistrict(namedDistrict) : parsedLocation.district;
  const marketRaw = text(attributes, "market");
  const propertyType = normalizeDetailLabel(`${text(category, "name") ?? ""} ${text(category, "type") ?? ""}`) === "flat sell" ? "apartment" : null;
  const buildingType = normalizePortalBuildingType(text(attributes, "building_type"), titleText, description);
  const price = decimal(atPath(unified, ["price", "salePrice", "value"])) ?? decimal(atPath(ad, ["price", "salePrice", "value"]));
  const area = decimal(attributes.m);
  const rooms = decimal(attributes.rooms_num);
  const floor = parseFloor(text(attributes, "floor_no"));
  const yearBuilt = parseExplicitConstructionYear(text(attributes, "build_year") ?? "");
  const active = normalizeDetailLabel(text(ad, "status") ?? "") === "active" && Boolean($("h1").length);
  const marketType = parseMarketType(null, marketRaw);
  return buildRadarDetail({ source: "otodom", active, titleText, description, price, area, rooms, floor, yearBuilt, city, district, locationText, buildingType, marketType, propertyType, explicitMarket: marketRaw });
}

type RadarDetailFactsInput = Omit<ParsedRadarPortalDetail, "verified" | "unconfirmedFields" | "contradictoryFields"> & { source: RadarDetailSource; titleText: string; explicitMarket?: string | null; areaLabel?: string | null };

function buildRadarDetail(input: RadarDetailFactsInput): ParsedRadarPortalDetail {
  const { active, titleText, description, price, area, rooms, floor, yearBuilt, city, district, locationText, buildingType, marketType, propertyType } = input;
  const finish = inspectRadarFinishEvidence(`${titleText} ${description ?? ""}`);
  const categoryBFinishConfirmed = marketType === "secondary" && hasCategoryBFinishEvidence(titleText, description);
  const normalizedFinishText = normalizeDetailLabel(`${titleText} ${description ?? ""}`);
  const unfinishedEvidence = /stan deweloperski|do wykonczenia|do remontu|wymaga remontu|remont w trakcie/u.test(normalizedFinishText);
  const finishStatusConfirmed = finish.fullRenovation || finish.turnkey || unfinishedEvidence || categoryBFinishConfirmed;
  const unconfirmedFields: string[] = [];
  const contradictoryFields: string[] = [];
  if (price === null || price <= 0) unconfirmedFields.push("total_price");
  if (area === null || area <= 0) unconfirmedFields.push("area");
  if (city !== "Łódź") unconfirmedFields.push("city_lodz");
  if (!district) unconfirmedFields.push("district");
  if (!buildingType) unconfirmedFields.push("building_type");
  else if (!["blok", "apartamentowiec"].includes(normalizeDetailLabel(buildingType))) contradictoryFields.push("building_type");
  const marketEvidence = normalizeDetailLabel(`${input.explicitMarket ?? ""} ${titleText} ${description ?? ""}`);
  const primaryEvidence = /rynek pierwotny|od dewelopera|nowa inwestycja|inwestycja deweloperska|primary market/u.test(marketEvidence);
  const secondaryEvidence = /rynek wtorny|secondary market/u.test(marketEvidence);
  if (primaryEvidence && secondaryEvidence) contradictoryFields.push("market_type");
  else if (!marketType) unconfirmedFields.push("market_type");
  if (propertyType !== "apartment") {
    (/(?:na|do) wynaj|czynsz najmu|dom|dzialk|lokal uzytkow/iu.test(normalizeDetailLabel(titleText)) ? contradictoryFields : unconfirmedFields).push("apartment_sale");
  }
  const positiveFinishEvidence = finish.fullRenovation || finish.turnkey || finish.freshFullRenovation || finish.moveInReady;
  if (positiveFinishEvidence && unfinishedEvidence) contradictoryFields.push("finish_evidence");
  else if (marketType === "secondary" && !categoryBFinishConfirmed) {
    if (!finish.fullRenovation) unconfirmedFields.push("renovation_completion");
    if (!finish.freshFullRenovation) unconfirmedFields.push("renovation_recency");
    if (!finish.moveInReady) unconfirmedFields.push("move_in_readiness");
  } else if (marketType === "primary" && !finish.turnkey) unconfirmedFields.push("turnkey_finish");
  else if (!marketType && !positiveFinishEvidence) unconfirmedFields.push("finish_evidence");
  if (!active) contradictoryFields.push("active_listing");
  contradictoryFields.push(...findRadarOwnListingConflicts({ price, area, rooms, floor, locationText, title: titleText, description }));
  const verified = active && price !== null && price > 0 && area !== null && area > 0 && city === "Łódź" && Boolean(buildingType) && Boolean(marketType) && propertyType === "apartment" && finishStatusConfirmed && contradictoryFields.length === 0;
  return { active, verified, unconfirmedFields: [...new Set(unconfirmedFields)], contradictoryFields: [...new Set(contradictoryFields)], price, area, rooms, floor, yearBuilt, city, district, locationText, buildingType, marketType, propertyType, description };
}

function labeledDetailValue($: ReturnType<typeof load>, labels: string[]): string | null {
  let found: string | null = null;
  $("dt, th, .mlc-params__parameter-name").each((_, element) => {
    if (found) return;
    const label = normalizeDetailLabel($(element).text());
    if (!labels.some((candidate) => label === normalizeDetailLabel(candidate))) return;
    const value = $(element).next("dd, td, .mlc-params__parameter-value").text().replace(/\s+/gu, " ").trim();
    if (value) found = value;
  });
  return found;
}

function normalizePortalBuildingType(value: string | null, title: string, description: string | null): string | null {
  const normalized = normalizeDetailLabel(value ?? "");
  if (/^(?:block|blok)$/u.test(normalized)) return "blok";
  if (/^(?:apartment building|apartamentowiec)$/u.test(normalized)) return "apartamentowiec";
  if (/^(?:tenement|kamienica)$/u.test(normalized)) return "kamienica";
  if (/^(?:house|dom)$/u.test(normalized)) return "dom";
  return resolveBuildingType(value, title, description);
}

function nestedName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  return isRecord(value) ? stringValue(value.name) ?? stringValue(value.label) ?? stringValue(value.value) : null;
}

function canonicalDetailUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
    url.pathname = url.pathname.replace(/\.html?$/iu, "").replace(/\/+$/u, "");
    return `${url.hostname}${url.pathname.toLowerCase()}`;
  } catch { return null; }
}

function decodeDetailText(value: string): string {
  return load(`<div>${value}</div>`).text().replace(/&sup2;|&#178;/giu, "²").replace(/\s+/gu, " ").trim();
}

function portalMoney(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" ? money(value) : null;
}

/** Construction year is accepted only from a dedicated source field label. */
function parseExplicitConstructionYear(value: string): number | null {
  const match = value.match(/\b(?:17|18|19|20|21)\d{2}\b/u);
  if (!match) return null;
  const year = Number(match[0]);
  return Number.isInteger(year) && year >= 1700 && year <= 2100 ? year : null;
}

function parseFloor(value: string | null): number | null {
  if (!value) return null;
  const normalized = normalizeDetailLabel(value);
  if (/\bparter\b/u.test(normalized)) return 0;
  const match = normalized.match(/\d{1,2}/u);
  return match ? Number(match[0]) : null;
}

function withUnconfirmedRadarDetail(base: PropertySourceListing, contradictions: string[] = []): PropertySourceListing {
  return { ...base, rawPayload: { ...base.rawPayload, detailAttempted: true, detailVerified: false, detailContradictions: contradictions } };
}

function compareRadarDetailIdentity(source: RadarDetailSource, listing: PropertySourceListing, requestedUrl: string, finalUrl: string): RadarDetailDiagnostic["identity"] {
  if (canonicalDetailUrl(requestedUrl) && canonicalDetailUrl(requestedUrl) === canonicalDetailUrl(finalUrl)) return "same_url";
  const idFromUrl = (value: string): string | null => {
    const id = source === "oferty_net" ? ofertyNetIdFromUrl(value)
      : source === "domiporta" ? lastPathSegmentId(value)
        : source === "otodom" ? extractOtodomListingId(value)
          : null;
    return id?.replace(/\.html?$/iu, "").toLowerCase() ?? null;
  };
  const expectedId = source === "adresowo" || source === "allegro_lokalnie" ? null : listing.externalListingId || idFromUrl(requestedUrl);
  const responseId = idFromUrl(finalUrl);
  if (expectedId && responseId) return expectedId.toLowerCase() === responseId ? "same_listing_id" : "mismatch";
  return "unconfirmed";
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /timed?\s*out|timeout/iu.test(error.message);
}

function mergeRadarDetail(base: PropertySourceListing, detail: ParsedRadarPortalDetail, response: { listingUrl: string; finalUrl: string; httpStatus: number; identity: string }): PropertySourceListing {
  const raw = { ...base.rawPayload };
  const candidate = isRecord(raw.candidate) ? raw.candidate : {};
  const resolvedCity = detail.city ?? base.city;
  const resolvedDistrict = detail.district ?? base.district;
  const resolvedLocationText = detail.locationText ?? base.locationText;
  const resolvedBuildingType = detail.buildingType ?? base.buildingType;
  const resolvedMarketType = detail.marketType ?? (typeof raw.marketType === "string" ? raw.marketType : null);
  const mergedCandidate = {
    ...candidate,
    price: detail.price ?? base.price,
    area: detail.area ?? base.area,
    rooms: detail.rooms ?? base.rooms,
    yearBuilt: detail.yearBuilt,
    city: resolvedCity,
    district: resolvedDistrict,
    buildingType: resolvedBuildingType,
    marketType: resolvedMarketType,
    propertyType: detail.propertyType ?? candidate.propertyType,
    detailAttempted: true,
    detailVerified: detail.verified,
    detailLocationText: resolvedLocationText,
    detailContradictions: detail.contradictoryFields,
    detailEvidence: { area: detail.area ?? base.area, rooms: detail.rooms ?? base.rooms, floor: detail.floor ?? parseFloor(base.floor), locationText: resolvedLocationText, price: detail.price ?? base.price, city: resolvedCity, district: resolvedDistrict, buildingType: resolvedBuildingType, marketType: resolvedMarketType, propertyType: detail.propertyType ?? candidate.propertyType ?? null, unconfirmedFields: detail.unconfirmedFields, contradictoryFields: detail.contradictoryFields, yearBuilt: detail.yearBuilt, yearBuiltSourceField: detail.yearBuilt === null ? null : "Rok budowy" },
  };
  const description = [base.description, detail.description].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index).join(" ") || null;
  const exactPrice = detail.price ?? base.price;
  const exactArea = detail.area ?? base.area;
  return {
    ...base,
    price: exactPrice,
    area: exactArea,
    rooms: detail.rooms ?? base.rooms,
    pricePerSqm: exactPrice && exactArea ? exactPrice / exactArea : null,
    description,
    rawPayload: { ...raw, source: base.source, candidate: mergedCandidate, marketType: resolvedMarketType, propertyType: detail.propertyType ?? candidate.propertyType, detailAttempted: true, detailVerified: detail.verified, detailActive: detail.active, detailIdentity: response.identity, detailLocationText: resolvedLocationText, detailContradictions: detail.contradictoryFields, detailResponse: response, detailEvidence: { area: detail.area ?? base.area, rooms: detail.rooms ?? base.rooms, floor: detail.floor ?? parseFloor(base.floor), locationText: resolvedLocationText, price: detail.price ?? base.price, city: resolvedCity, district: resolvedDistrict, buildingType: resolvedBuildingType, marketType: resolvedMarketType, propertyType: detail.propertyType ?? candidate.propertyType ?? null, unconfirmedFields: detail.unconfirmedFields, contradictoryFields: detail.contradictoryFields, yearBuilt: detail.yearBuilt, yearBuiltSourceField: detail.yearBuilt === null ? null : "Rok budowy" } },
    city: resolvedCity,
    district: resolvedDistrict,
    locationText: resolvedLocationText,
    buildingType: resolveBuildingType(resolvedBuildingType, base.title, description),
  };
}

function parseRadarLocation(value: string): { city: string | null; district: string | null } {
  const rawParts = value.split(/[,;|\n]+/u).map((part) => part.trim()).filter(Boolean);
  const parts = rawParts.map(normalizeDetailLabel).filter(Boolean);
  const city = parts.some((part) => part === "lodz" || part.startsWith("lodz ")) ? "\u0141\u00f3d\u017a" : null;
  const districts: Array<[string, string]> = [["baluty", "Ba\u0142uty"], ["gorna", "G\u00f3rna"], ["polesie", "Polesie"], ["srodmiescie", "\u015ar\u00f3dmie\u015bcie"], ["widzew", "Widzew"]];
  const tokens = new Set(parts.flatMap((part) => part.split(" ")));
  const district = districts.find(([key]) => tokens.has(key))?.[1]
    ?? rawParts
      .flatMap((part) => {
        const placeTokens = part.split(/\s+/u).filter((token) => {
          const normalized = normalizeDetailLabel(token).replace(/[,.]+$/gu, "");
          return normalized && normalized !== "lodz" && normalized !== "lodzkie" && normalized !== "ul";
        });
        return placeTokens.length ? [placeTokens.join(" "), ...placeTokens] : [];
      })
      .map(resolveKnownRadarDistrict).find((item): item is string => Boolean(item))
    ?? null;
  return { city, district };
}

function parseMarketType(primaryValue: string | null, marketValue: string | null): "primary" | "secondary" | null {
  const primary = normalizeDetailLabel(primaryValue ?? "");
  if (["tak", "yes", "1"].includes(primary)) return "primary";
  if (["nie", "no", "0"].includes(primary)) return "secondary";
  const market = normalizeDetailLabel(marketValue ?? "");
  if (/pierwotny|deweloperski|primary market|\bprimary\b/u.test(market)) return "primary";
  if (/wtorny|secondary market|\bsecondary\b|\bresale\b/u.test(market)) return "secondary";
  return null;
}

function normalizeDetailLabel(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/gu, "l").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function assertNotAccessChallenge(source: string, html: string): void {
  const $ = load(html);
  const title = $("title").first().text();
  const visible = $("body").text().slice(0, 4000);
  if (/captcha|verify\s+you\s+are\s+human|access\s+denied|zablokowano\s+dostęp|potwierdź,?\s+że\s+nie\s+jesteś\s+robotem/iu.test(`${title} ${visible}`)) {
    throw new Error(`${source}: CAPTCHA_OR_ACCESS_DENIED (no retry or bypass).`);
  }
}

type OfertyNetLocationIds = { country: string; region: string; city: string };

async function resolveOfertyNetLocation(config: ExternalSourceConfig, city: string, signal?: AbortSignal): Promise<OfertyNetLocationIds> {
  const contextUrl = new URL(config.searchPath(city), `https://${config.hostnames[0]}`).toString();
  const response = await fetchExternalPage(contextUrl, signal);
  if (!response.ok) throw new Error(`${config.label}: HTTP ${response.status} (city search context).`);
  const html = await response.text();
  assertNotAccessChallenge(config.label, html);
  const finalUrl = response.url || contextUrl;
  if (!absoluteUrl(finalUrl, config.id)) throw new Error(`${config.label}: CITY_SEARCH_CONTEXT_HOST_MISMATCH.`);
  const expectedPath = new URL(contextUrl).pathname.replace(/\/$/u, "");
  const finalPath = new URL(finalUrl).pathname.replace(/\/$/u, "");
  if (finalPath !== expectedPath) throw new Error(`${config.label}: CITY_SEARCH_CONTEXT_REDIRECTED.`);
  const match = html.match(/myOfertyLocationSelector\s*\(\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*\)/iu);
  if (!match) throw new Error(`${config.label}: LOCATION_SELECTOR_NOT_CONFIRMED.`);
  if (match[1] === "0" || match[2] === "0" || match[3] === "0") throw new Error(`${config.label}: CITY_LOCATION_NOT_SELECTED.`);
  return { country: match[1]!, region: match[2]!, city: match[3]! };
}

function pageUrl(config: ExternalSourceConfig, criteria: ExternalPortalCriteria, page: number, ofertyLocation: OfertyNetLocationIds | null = null, ofertyNetLegacySearch = false): string {
  const city = criteria.city ?? "";
  const base = new URL(config.searchPath(city), `https://${config.hostnames[0]}`);
  if (config.id === "oferty_net" && !ofertyNetLegacySearch) {
    // Names and values come from Oferty.net's public GET search form. The
    // older /mieszkania,<city> shortcut mixed sale and rental rows and could
    // not carry the selected area/room bounds.
    base.pathname = "/mieszkania/szukaj";
    base.search = "";
    base.searchParams.set("ps[type]", "1");
    base.searchParams.set("ps[transaction]", "1");
    if (!ofertyLocation) throw new Error(`${config.label}: LOCATION_SELECTOR_NOT_CONFIRMED.`);
    base.searchParams.set("ps[location][type]", "4");
    base.searchParams.set("ps[location][select_level0]", ofertyLocation.country);
    base.searchParams.set("ps[location][select_level1]", ofertyLocation.region);
    base.searchParams.set("ps[location][select_level2]", ofertyLocation.city);
    base.searchParams.append("ps[location][select_level3][]", "0");
    if (criteria.areaMin !== null && criteria.areaMin !== undefined) base.searchParams.set("ps[living_area_from]", String(criteria.areaMin));
    if (criteria.areaMax !== null && criteria.areaMax !== undefined) base.searchParams.set("ps[living_area_to]", String(criteria.areaMax));
    const rooms = [...new Set((criteria.rooms ?? []).filter((room) => Number.isInteger(room) && room > 0))].sort((a, b) => a - b);
    if (rooms.length) {
      base.searchParams.set("ps[number_of_rooms_from]", String(rooms[0]));
      base.searchParams.set("ps[number_of_rooms_to]", String(rooms.at(-1)));
    }
  }
  if (config.id === "adresowo" && page > 1) {
    // Confirmed against the real public page (2026-10-11): Adresowo's own
    // rel="next"/"prev"/"canonical" links rotate through a path suffix
    // (bare URL -> "/_l2" -> "/_l3" -> ...), not a "page" query string --
    // the generic ?page=N below is silently ignored by the server, which
    // would otherwise re-fetch the same first page on every later "page".
    base.pathname = `${base.pathname.replace(/\/$/u, "")}/_l${page}`;
    return base.toString();
  }
  if (page > 1) base.searchParams.set("page", String(page));
  return base.toString();
}

function publicSearchPageLimitWarning(config: ExternalSourceConfig): string {
  return `${config.label}: PUBLIC_SEARCH_PAGE_LIMIT_REACHED (${MAX_PAGES} pages); later pages were not requested.`;
}

// Real public structure, confirmed against gratka.pl/nieruchomosci/mieszkania/<city>
// (read-only GET, 2026-10-03): the page embeds exactly one schema.org Product
// whose `offers` is a single AggregateOffer carrying every visible listing as
// its own nested Offer in `offers.offers[]` -- never an ItemList, and never one
// JSON-LD record per listing the way domiporta/adresowo/domy render.
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

// Real public structure, confirmed against lodz.nieruchomosci-online.pl/mieszkania,sprzedaz/
// (read-only GET, 2026-10-03): the page has no __NEXT_DATA__ at all (the
// previous implementation's entire approach never matched anything real).
// It embeds a CollectionPage whose mainEntity (a Product) carries every
// visible listing as a nested Offer inside mainEntity.offers[0].offers[] --
// the exact same AggregateOffer-wraps-individual-Offers shape Gratka uses,
// just one level deeper (CollectionPage -> mainEntity -> offers[0] rather
// than Product -> offers directly). addressLocality here genuinely IS the
// city ("Łódź"), unlike Gratka's quirk -- used directly, not left to
// fallbackCity.
function parseNieruchomosciOnline(html: string, fallbackCity: string): ExternalPortalPage {
  const collectionPage = jsonLdRecords(html).find((record) => isRecord(record.mainEntity));
  const offers = collectionPage ? aggregateOfferItems((collectionPage.mainEntity as PortalRecord).offers) : [];
  return fromCandidates("nieruchomosci_online", offers.map(fromNieruchomosciOnlineRecord), fallbackCity, hasNextMarker(html));
}

/** Unwraps `{...AggregateOffer, offers: [...]}` whether it arrives as that object directly (Gratka) or as a one-element array wrapping it (nieruchomosci-online's `mainEntity.offers[0]`). */
function aggregateOfferItems(value: unknown): PortalRecord[] {
  const aggregate = Array.isArray(value) ? value.find(isRecord) : isRecord(value) ? value : null;
  return aggregate && Array.isArray(aggregate.offers) ? (aggregate.offers as unknown[]).filter(isRecord) : [];
}

function parseDomiporta(html: string, fallbackCity: string): ExternalPortalPage {
  const jsonCandidates = jsonLdItemListCandidates(html)
    .filter((record) => hasType(record, "Product", "RealEstateListing", "Residence", "Apartment"))
    .map(fromDomiportaRecord);
  if (jsonCandidates.length) return fromCandidates("domiporta", jsonCandidates, fallbackCity, hasNextMarker(html));
  const $ = load(html); const candidates: PortalCandidate[] = [];
  $("article[data-offer-id], [data-listing-id], [data-testid='listing-card']").each((_, element) => { const card = $(element); const image = card.find("img").first().attr("src") ?? card.find("img").first().attr("data-src"); candidates.push({ id: card.attr("data-offer-id") ?? card.attr("data-listing-id"), url: card.attr("data-url") ?? card.find("a[href]").first().attr("href"), title: card.attr("data-title") ?? card.find("h2,h3,[data-title]").first().text(), price: card.attr("data-price") ?? card.find("[data-price],.price").first().text(), area: card.attr("data-area") ?? card.find("[data-area],.area").first().text(), rooms: card.attr("data-rooms") ?? card.find("[data-rooms],.rooms").first().text(), city: card.attr("data-city") ?? fallbackCity, district: card.attr("data-district"), images: image ? [image] : [] }); });
  return fromCandidates("domiporta", candidates, fallbackCity, Boolean($("a[rel='next'], [data-next-page='true']").length));
}

function parseSprzedajemy(html: string, fallbackCity: string): ExternalPortalPage {
  const state = namedJson(html, "__INITIAL_STATE__"); const rows = arrayAt(state, ["offers"]) ?? arrayAt(state, ["search", "offers"]) ?? [];
  const stateCandidates = rows.filter(isRecord).map((row) => ({ id: row.id ?? row.offerId, url: row.url ?? row.link, title: row.title ?? row.name, description: row.description, price: row.price, area: row.area ?? row.m2, rooms: row.rooms, city: row.city, district: row.district, buildingType: row.buildingType ?? row.building_type, ownership: row.ownership ?? row.ownershipType, images: row.images ?? row.photos, publishedAt: row.datePosted ?? row.datePublished ?? row.publishedAt, sourceRecord: row }));
  const jsonCandidates = jsonLdItemListCandidates(html)
    .filter((record) => hasType(record, "Offer", "Product", "Residence", "Apartment") || Array.isArray(record["@type"]))
    .map((record) => fromSprzedajemyRecord(record));
  return fromCandidates("sprzedajemy", [...stateCandidates, ...jsonCandidates], fallbackCity, Boolean(atPath(state, ["pagination", "next"])) || hasNextMarker(html));
}

function parseAdresowo(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html); const cardCandidates: PortalCandidate[] = [];
  $("[data-offer-card]").each((_, element) => {
    const card = $(element);
    const image = card.find("img").first();
    const href = card.find("a[href]").filter((__, link) => ($(link).attr("href") ?? "").includes("/o/")).first().attr("href") ?? card.find("a[href]").first().attr("href");
    // Each field (price/area/rooms) lives in its own <p>; scanning the
    // whole card's flattened text instead is unsafe for two reasons
    // confirmed against the real public page (2026-10-11): a trailing
    // word-boundary check never matches right after the currency
    // suffix (its last letter is outside \w to the JS regex engine, so
    // no boundary forms there), and even with that fixed, the card's
    // own photo-count badge (e.g. "11" for 11 photos) sits right before
    // the price in DOM order and gets swallowed into the same match as
    // "11 228 000". Scoping each regex to the one <p> naming its own
    // unit avoids both.
    const fieldValue = (unitPattern: RegExp): string | undefined => {
      let value: string | undefined;
      card.find("p").each((__, fieldElement) => {
        if (value !== undefined) return;
        const fieldText = $(fieldElement).text().replace(/\s+/gu, " ").trim();
        if (!unitPattern.test(fieldText)) return;
        value = fieldText.match(/[\d\s.,]+/u)?.[0]?.trim();
      });
      return value;
    };
    const price = fieldValue(/pln|zł/iu);
    const area = fieldValue(/m²|m2|mkw/iu);
    const rooms = fieldValue(/pok/iu);
    cardCandidates.push({
      id: card.attr("data-id"),
      url: href,
      title: card.find("h1,h2,h3").first().text() || image.attr("alt"),
      price,
      area,
      rooms,
      city: fallbackCity,
      images: (image.attr("src") ?? image.attr("data-src")) ? [image.attr("src") ?? image.attr("data-src")] : [],
    });
  });
  if (cardCandidates.length) return fromCandidates("adresowo", cardCandidates, fallbackCity, hasNextMarker(html));
  const records = jsonLdRecords(html).filter((record) => /residence|apartment|house|product/iu.test(text(record, "@type") ?? ""));
  return fromCandidates("adresowo", records.map(fromAdresowoRecord), fallbackCity, hasNextMarker(html));
}

// Real public structure, confirmed against oferty.net's own public search
// page (read-only GET, 2026-10-03): the previous "zero price mentions"
// conclusion was wrong -- it only checked for a literal "zł" substring, but
// this page's prices are plain numbers with no currency suffix (e.g.
// "425 000", not "425 000 zł"). The page is genuinely server-rendered: a
// real <table> of listing rows (`tr.property`, cells cell_location/
// cell_area/cell_rooms/cell_price/cell_added_at), not client-side AJAX.
// Rental rows ("na wynajem") are mixed into the same table as sale rows;
// the image `alt` text carries the real "na sprzedaż"/"na wynajem"/"do
// wynajęcia" wording, which the existing RENTAL_SIGNAL check filters via
// title/description. Pagination is a numbered ?page=N paginator with no
// rel="next" marker, so hasNextPage is derived from the paginator's own
// "current" page vs. the highest page number it lists.
function parseOfertyNet(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html); const candidates: PortalCandidate[] = [];
  $("tr.property").each((_, element) => {
    const row = $(element);
    const link = row.find("td.cell_location a").first();
    const url = link.attr("href");
    const locationTitle = link.attr("title") ?? "";
    const districtLabel = locationTitle.match(/,\s*([^,]+)$/u)?.[1]?.trim() ?? null;
    const img = row.find("img").first();
    candidates.push({
      id: url ? ofertyNetIdFromUrl(url) : undefined,
      url,
      title: img.attr("alt"),
      description: img.attr("alt"),
      price: row.find("td.cell_price").first().text(),
      area: areaFromText(row.find("td.cell_area").first().text()),
      rooms: row.find("td.cell_rooms").first().text(),
      city: fallbackCity,
      district: districtLabel && !["lodz", "lodzkie"].includes(normalizeDetailLabel(districtLabel)) ? districtLabel : null,
      images: img.attr("data-original") ?? img.attr("src"),
      publishedAt: row.find("td.cell_added_at").first().text().match(/\d{4}-\d{2}-\d{2}/u)?.[0],
    });
  });
  const current = Number($(".paginator .current a").first().text().trim());
  let maxPage = current;
  $(".paginator .navigate a").each((_, element) => { const page = Number($(element).text().trim()); if (Number.isFinite(page)) maxPage = Math.max(maxPage, page); });
  return fromCandidates("oferty_net", candidates, fallbackCity, Number.isFinite(current) && maxPage > current);
}
function ofertyNetIdFromUrl(url: string): string | null { try { return new URL(url).pathname.match(/,([^,/]+)$/u)?.[1] ?? lastPathSegmentId(url); } catch { return lastPathSegmentId(url); } }

function parseBezposrednio(html: string, fallbackCity: string): ExternalPortalPage {
  const data = nextData(html); const rows = arrayAt(data, ["props", "pageProps", "listings"]) ?? arrayAt(data, ["props", "pageProps", "results"]) ?? [];
  const candidates = rows.filter(isRecord).map((row) => ({ id: row.id ?? row.slug, url: row.url ?? row.href, title: row.title ?? row.name, description: row.description, price: row.price, area: row.area, rooms: row.rooms, floor: row.floor, city: row.city, district: row.district, images: row.images, publishedAt: row.publishedAt }));
  return fromCandidates("bezposrednio", candidates, fallbackCity, Boolean(atPath(data, ["props", "pageProps", "pagination", "hasNextPage"])));
}

// Real public structure, confirmed against domy.pl (read-only GET,
// 2026-10-03): the registered /mieszkania/sprzedam/<city> path reaches a
// genuine Łódź-titled page, but its <article> cards are an unrelated
// "podobne inwestycje" (similar developments) widget showing other cities
// entirely -- the real listing path is a completely different URL,
// /mieszkania--<city>-pl, found via the search form's own "shortcuts"
// sidebar links. That real page has no JSON-LD/__NEXT_DATA__ at all; it is
// server-rendered <article class="propertyBox"> cards with a plain-numeric
// price (no "zł" substring, which is why the previous investigation's "zero
// price mentions" check never saw it). Room count is never a number -- it
// is a Polish word prefix in the card's title attribute ("Dwupokojowe
// mieszkanie...", "Kawalerka..."), parsed via a fixed lookup rather than a
// numeric field. Pagination is a real ?page=N control whose own markup
// already includes a literal rel="next" link, so the existing generic
// hasNextMarker() check (originally written for the other portals) already
// works here unmodified.
const DOMY_ROOM_WORDS: Record<string, number> = { kawalerka: 1, jednopokojowe: 1, dwupokojowe: 2, trzypokojowe: 3, czteropokojowe: 4, pieciopokojowe: 5, szesciopokojowe: 6, siedmiopokojowe: 7, osmiopokojowe: 8 };
function parseDomy(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html); const candidates: PortalCandidate[] = [];
  $("article.propertyBox").each((_, element) => {
    const card = $(element);
    const link = card.find("a.property_link").first();
    const url = link.attr("href");
    const titleAttr = link.attr("title") ?? "";
    const [city, ...districtParts] = link.text().split(",").map((part) => part.trim()).filter(Boolean);
    candidates.push({
      id: url ? lastPathSegmentId(url) : undefined,
      url,
      title: titleAttr,
      description: titleAttr,
      price: card.find(".price").first().text(),
      area: areaFromText(card.find(".area").first().text()),
      rooms: domyRoomsFromTitle(titleAttr),
      city: city ?? fallbackCity,
      district: districtParts.length ? districtParts.join(", ") : null,
    });
  });
  return fromCandidates("domy", candidates, fallbackCity, hasNextMarker(html));
}
function domyRoomsFromTitle(title: string): number | null {
  const word = title.toLocaleLowerCase("pl-PL").match(/^(\p{L}+)/u)?.[1];
  if (!word) return null;
  return DOMY_ROOM_WORDS[word.normalize("NFD").replace(/[̀-ͯ]/gu, "")] ?? null;
}

// Real public structure, confirmed against allegrolokalnie.pl (read-only
// GET, 2026-10-03): the registered /oferty/nieruchomosci/mieszkania path
// redirects away entirely (it drops the "mieszkania" filter and lands on
// the generic nieruchomosci category). The real combined category+city path
// is /oferty/nieruchomosci/mieszkania-na-sprzedaz-112739/<city> (confirmed
// genuinely city-scoped: a page titled "Mieszkania na sprzedaż - Łódź" with
// 60 items, every url/name actually naming "lodz"/a real Łódź district --
// not the previously-seen byte-identical nationwide content). The page has
// no __NEXT_DATA__ at all (the previous parser's assumption never matched
// anything real); real data is a flat schema.org ItemList in JSON-LD, but
// unlike every other ItemList-shaped portal in this file, items carry no
// separate area/rooms/address fields -- only a free-text name ("Mieszkanie,
// Łódź, <district>, <area> m²") to parse them from, and no room count
// anywhere. Pagination is a numbered ?page=N control (confirmed genuinely
// paginating -- unlike the ignored ?p=/?strona= guesses tried first) shown
// via a disabled <input> with the current/total page count, not a
// rel="next" link.
// Allegro Lokalnie's own JSON-LD Product record has no sku/productID/
// identifier at all, and its listing URL's trailing slug (e.g.
// "...-68-m2-ujw") is NOT a stable per-listing id: the same real listing
// reappears across scans with a different random 3-character suffix (e.g.
// "-ujw" one scan, "-oos"/"-q5f" another), confirmed live by comparing a
// current search page against this app's own stored scan history for the
// exact same listing (identical title/price/area/image, three different
// URLs) -- every scan previously created a brand-new row instead of
// updating the existing one, permanently accumulating duplicate Finder
// cards for one real apartment.
//
// An earlier fix used the CDN image path as the identity anchor instead.
// That was wrong and has been reverted: a shared photo proves nothing about
// listing or property identity by itself. A stock/template image two
// genuinely different real apartments happen to share would wrongly fuse
// two different listings into one id, and an ordinary photo swap on the
// seller's own listing would wrongly split one real listing back into two.
// Shared photos still feed `sharedPhotoAssetKeys` (via `images` into
// extractListingIdentityEvidence below) for the existing manual
// review/candidate system -- they are never used to set this id.
//
// The real structural id lives elsewhere: each card's own HTML element (the
// same `a.mlc-itembox` card already read below for its "Rok budowy"
// parameter) additionally carries a portal-assigned per-offer UUID,
// duplicated in two of its own analytics attributes
// (data-card-analytics-click, and the matching lokalnie_offer_id field
// inside data-experiment-analytics) -- confirmed present and mutually
// distinct across all 60 real cards on a live search page, and clearly
// independent of the url's rotating slug. This is the same kind of
// backend-assigned field other adapters in this file read from
// sku/productID/identifier; reading it from the HTML card instead of the
// JSON-LD block follows the exact pathname-correlation pattern
// allegroLokalnieYearBuiltByPath already uses for yearBuilt.
//
// It has not been possible to directly re-confirm this specific id stayed
// the same across a slug rotation already recorded in this app's own
// history: no prior scan ever captured the HTML card's analytics
// attributes, only the JSON-LD candidate fields, so rows stored before this
// fix cannot be retroactively proven identical this way. They are
// deliberately left as separate rows (see the regression tests for this
// adapter) pending an explicit manual decision through the existing
// identity grouping flow -- never auto-merged on a rotation that is not a
// confirmed fact. The url slug remains the fallback id for any card where
// this attribute is absent or malformed.
function allegroLokalnieOfferIdByPath($: ReturnType<typeof load>): Map<string, string> {
  const offerIdByPath = new Map<string, string>();
  $("a.mlc-itembox[itemprop='url']").each((_index, anchor) => {
    const href = $(anchor).attr("href");
    const path = href ? pathnameOf(href, "https://allegrolokalnie.pl") : null;
    if (!path) return;
    const offerId = $(anchor).attr("data-card-analytics-click");
    if (offerId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(offerId)) {
      offerIdByPath.set(path, offerId.toLocaleLowerCase("en-US"));
    }
  });
  return offerIdByPath;
}

function parseAllegroLokalnie(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html);
  const yearBuiltByPath = allegroLokalnieYearBuiltByPath($);
  const offerIdByPath = allegroLokalnieOfferIdByPath($);
  const candidates = jsonLdItemListCandidates(html).filter((record) => hasType(record, "Product")).map((record) => {
    const url = text(record, "url");
    const name = stringValue(record.name) ?? "";
    // The area's own decimal separator is a comma ("53,2 m²"), so the area
    // must be peeled off with its own end-anchored match BEFORE splitting
    // the rest of the name on commas -- otherwise "53,2" is misread as two
    // separate comma-joined parts ("53" and "2 m²").
    const areaMatch = name.match(/\d+(?:,\d+)?\s*(?:m²|m2|mkw)\s*$/iu);
    const withoutArea = areaMatch ? name.slice(0, areaMatch.index).replace(/,\s*$/u, "") : name;
    const parts = withoutArea.split(",").map((part) => part.trim()).filter(Boolean);
    let yearBuilt: number | null = null;
    const urlPath = url !== null ? pathnameOf(url) : null;
    if (urlPath !== null) {
      yearBuilt = yearBuiltByPath.get(urlPath) ?? null;
    }
    const image = atPath(record, ["image", "url"]) ?? atPath(record, ["image", "contentUrl"]);
    return {
      id: (urlPath !== null ? offerIdByPath.get(urlPath) : null) ?? (url ? lastPathSegmentId(url) : undefined),
      url: record.url,
      title: record.name,
      price: atPath(record, ["offers", "price"]),
      area: areaMatch ? areaFromText(areaMatch[0]) : null,
      city: fallbackCity,
      district: parts.length > 2 ? parts.slice(2).join(", ") || null : null,
      images: image,
      yearBuilt,
    };
  });
  const current = Number($(".ml-pagination__input").attr("value"));
  const total = Number($(".ml-pagination__count").first().text().match(/\d+/u)?.[0]);
  return fromCandidates("allegro_lokalnie", candidates, fallbackCity, Number.isFinite(current) && Number.isFinite(total) && current < total);
}

/**
 * The JSON-LD ItemList (one <script> block, used for price/area/title above)
 * never carries a construction year -- Allegro Lokalnie only states it as a
 * plain-text, explicitly labeled parameter ("Rok budowy: 1897") inside each
 * card's own HTML, alongside siblings like "Rynek:"/"Typ budynku:" in the
 * exact same list. Reading it from there, scoped to one <li> per labeled
 * parameter, is what keeps this an explicit-field read rather than a guess
 * from age/material -- it never looks at the free-text title/description.
 * Each HTML card and its JSON-LD counterpart describe the same offer but use
 * different URL forms (a relative href vs. an absolute https://allegrolokalnie.pl/...
 * URL), so cards are keyed by pathname, the one part guaranteed to match.
 */
function allegroLokalnieYearBuiltByPath($: ReturnType<typeof load>): Map<string, number> {
  const yearBuiltByPath = new Map<string, number>();
  $("a.mlc-itembox[itemprop='url']").each((_index, anchor) => {
    const href = $(anchor).attr("href");
    const path = href ? pathnameOf(href, "https://allegrolokalnie.pl") : null;
    if (!path) return;
    $(anchor).find("li.mlc-itembox__params__param").each((_paramIndex, parameter) => {
      const match = $(parameter).text().match(/Rok budowy:\s*([12]\d{3})/u);
      const year = match ? Number(match[1]) : null;
      if (year !== null && year >= 1700 && year <= 2100) yearBuiltByPath.set(path, year);
    });
  });
  return yearBuiltByPath;
}

function pathnameOf(value: string, base?: string): string | null {
  try {
    return new URL(value, base).pathname;
  } catch {
    return null;
  }
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
  return { id: record.sku ?? record.productID ?? record.identifier ?? (url ? lastPathSegmentId(url) : undefined), url: record.url, title: record.name, description: itemOffered.description, price: record.price, area: atPath(itemOffered, ["floorSize", "value"]) ?? itemOffered.area, rooms: itemOffered.numberOfRooms, floor: itemOffered.floorLevel, district: atPath(itemOffered, ["address", "addressLocality"]), buildingType: record.buildingType ?? itemOffered.buildingType ?? itemOffered.building_type, ownership: record.ownership ?? itemOffered.ownership ?? itemOffered.ownershipType, images: record.image, publishedAt: record.datePosted ?? record.datePublished, sourceRecord: record };
}
function lastPathSegmentId(url: string): string | null { try { return new URL(url).pathname.split("/").filter(Boolean).pop() ?? null; } catch { return null; } }
function fromNieruchomosciOnlineRecord(record: PortalRecord): PortalCandidate { const itemOffered = isRecord(record.itemOffered) ? record.itemOffered : record; const address = isRecord(itemOffered.address) ? itemOffered.address : {}; const url = text(record, "url"); return { id: record.sku ?? record.productID ?? record.identifier ?? (url ? lastPathSegmentId(url) : undefined), url: record.url, title: record.name, description: itemOffered.description, price: record.price, area: atPath(itemOffered, ["floorSize", "value"]), rooms: itemOffered.numberOfRooms, city: text(address, "addressLocality"), buildingType: record.buildingType ?? itemOffered.buildingType ?? itemOffered.building_type, ownership: record.ownership ?? itemOffered.ownership ?? itemOffered.ownershipType, images: record.image, publishedAt: record.datePosted, sourceRecord: record }; }
function fromDomiportaRecord(record: PortalRecord): PortalCandidate { const nestedOffer = atPath(record, ["offers", "itemOffered"]); const offered = isRecord(record.itemOffered) ? record.itemOffered : isRecord(nestedOffer) ? nestedOffer : record; return { id: record.sku ?? record.productID ?? record.identifier ?? record.url, url: record.url, title: record.name, description: record.description, price: atPath(record, ["offers", "price"]) ?? record.price, area: atPath(offered, ["floorSize", "value"]) ?? offered.area, rooms: offered.numberOfRooms, floor: offered.floorLevel, city: atPath(offered, ["address", "addressLocality"]), district: atPath(offered, ["address", "addressSuburb"]), buildingType: record.buildingType ?? offered.buildingType ?? offered.building_type, ownership: record.ownership ?? offered.ownership ?? offered.ownershipType, images: record.image, publishedAt: record.datePosted ?? record.datePublished, sourceRecord: record }; }
function fromAdresowoRecord(record: PortalRecord): PortalCandidate { const offered = isRecord(record.itemOffered) ? record.itemOffered : record; return { id: record.identifier ?? record.sku, url: record.url ?? record.mainEntityOfPage, title: record.name, description: record.description, price: atPath(record, ["offers", "price"]) ?? record.price, area: atPath(offered, ["floorSize", "value"]) ?? offered.area, rooms: offered.numberOfRooms, floor: offered.floorLevel, city: atPath(offered, ["address", "addressLocality"]), district: atPath(offered, ["address", "addressSuburb"]), buildingType: record.buildingType ?? offered.buildingType ?? offered.building_type, ownership: record.ownership ?? offered.ownership ?? offered.ownershipType, images: record.image, publishedAt: record.datePosted, sourceRecord: record }; }
function fromSprzedajemyRecord(record: PortalRecord): PortalCandidate { const title = stringValue(record.name) ?? stringValue(record.title); return { id: record.sku ?? record.productID ?? record.identifier ?? record.url, url: record.url, title, description: record.description, price: atPath(record, ["offers", "price"]) ?? record.price, area: record.area ?? areaFromText(title), rooms: record.numberOfRooms ?? record.rooms ?? roomsFromText(title), city: atPath(record, ["address", "addressLocality"]), district: atPath(record, ["address", "addressSuburb"]), buildingType: record.buildingType ?? record.building_type, ownership: record.ownership ?? record.ownershipType, images: record.image, publishedAt: record.datePosted ?? record.datePublished, sourceRecord: record }; }
function fromCandidates(source: ExternalSourceId, candidates: PortalCandidate[], fallbackCity: string, hasNextPage: boolean): ExternalPortalPage {
  const listings: PropertySourceListing[] = [];
  const detailCandidates: PropertySourceListing[] = [];
  const seen = new Set<string>();
  const seenDetails = new Set<string>();
  let invalidSalePriceCount = 0;
  for (const candidate of candidates) {
    const url = absoluteUrl(candidate.url, source);
    const title = stringValue(candidate.title);
    const description = stringValue(candidate.description);
    if (url && !isSearchUrl(url) && !isRadarRentalTransactionText(`${title ?? ""} ${description ?? ""}`) && (money(candidate.price) === null || money(candidate.price)! <= 0)) invalidSalePriceCount += 1;
    const detailCandidate = toListing(source, candidate, fallbackCity, true);
    if (detailCandidate && !seenDetails.has(detailCandidate.externalListingId)) {
      seenDetails.add(detailCandidate.externalListingId);
      detailCandidates.push(detailCandidate);
    }
    const listing = toListing(source, candidate, fallbackCity);
    if (!listing || seen.has(listing.externalListingId)) continue;
    seen.add(listing.externalListingId);
    listings.push(listing);
  }
  return { listings, detailCandidates, hasNextPage, invalidSalePriceCount };
}
function toListing(source: ExternalSourceId, candidate: PortalCandidate, fallbackCity: string, allowIncompleteForDetail = false): PropertySourceListing | null {
  const url = absoluteUrl(candidate.url, source);
  const title = stringValue(candidate.title);
  const description = stringValue(candidate.description);
  if (!url || isSearchUrl(url) || isRadarRentalTransactionText(`${title ?? ""} ${description ?? ""}`)) return null;
  const price = money(candidate.price);
  const area = decimal(candidate.area);
  if (!allowIncompleteForDetail && (price === null || price <= 0 || area === null || area <= 0)) return null;
  const city = stringValue(candidate.city) ?? fallbackCity;
  const district = stringValue(candidate.district);
  const externalListingId = stringValue(candidate.id) ?? new URL(url).pathname.replace(/\/+$/u, "");
  const images = imageValues(candidate.images);
  const rooms = decimal(candidate.rooms);
  const floor = stringValue(candidate.floor);
  const cleanDescription = description ? stripHtml(description) : null;
  const normalizedUrl = normalizeUrl(url);
  const payload = { id: externalListingId, url: normalizedUrl, title, price, area, rooms, city, district };
  const buildingType = resolveBuildingType(candidate.buildingType, title, cleanDescription);
  const identityEvidence = extractListingIdentityEvidence({ source, title, description: cleanDescription, city, district, area, rooms, floor, images, buildingType, sourceRecord: candidate.sourceRecord });
  const safeCandidate = { id: candidate.id, url: candidate.url, title: candidate.title, description: candidate.description, price: candidate.price, area: candidate.area, rooms: candidate.rooms, floor: candidate.floor, city: candidate.city, district: candidate.district, images: candidate.images, publishedAt: candidate.publishedAt, yearBuilt: candidate.yearBuilt, buildingType: candidate.buildingType, ownership: candidate.ownership, marketType: candidate.marketType, propertyType: candidate.propertyType };
  const marketType = candidate.marketType === "primary" || candidate.marketType === "secondary" ? candidate.marketType : null;
  const propertyType = stringValue(candidate.propertyType);
  return { source, externalListingId, originalUrl: url, normalizedUrl, title, price, area, rooms, floor, pricePerSqm: price && area ? price / area : null, city, district, locationText: [district, city].filter(Boolean).join(", ") || null, thumbnailUrl: images[0] ?? null, images, buildingType, ownership: resolveOwnership(candidate.ownership, title, cleanDescription), yearBuilt: yearBuiltValue(candidate.yearBuilt), description: cleanDescription, publishedAt: stringValue(candidate.publishedAt), rawPayload: { source, candidate: safeCandidate, ...(marketType ? { marketType } : {}), ...(propertyType ? { propertyType } : {}) }, contentHash: calculateContentHash(payload), identityEvidence };
}

function absoluteUrl(value: unknown, source: ExternalSourceId): string | null { const raw = stringValue(value); if (!raw) return null; const host = SOURCE_HOSTS[source]; try { const url = new URL(raw, `https://${host}`); if (url.protocol !== "https:" || (url.hostname !== host && !url.hostname.endsWith(`.${host}`))) return null; return url.toString(); } catch { return null; } }
function isSearchUrl(value: string): boolean { const path = new URL(value).pathname.toLocaleLowerCase("pl-PL"); return /\/(wyniki|search|szukaj|mieszkania\/sprzedam|nieruchomosci\/mieszkania\/sprzedam|oferty\/nieruchomosci\/mieszkania|nieruchomosci\/mieszkania\/[a-z-]+)\/?$/u.test(path); }
function normalizeUrl(value: string): string { const url = new URL(value); url.hash = ""; url.hostname = url.hostname.toLowerCase(); for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key); url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/"; return url.toString(); }
function jsonLdRecords(html: string): PortalRecord[] { const output: PortalRecord[] = []; for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) { try { collectJson(JSON.parse(decodeEntities(match[1])), output); } catch { /* malformed blocks are ignored */ } } return output; }
function collectJson(value: unknown, output: PortalRecord[]): void { if (Array.isArray(value)) { value.filter(isRecord).forEach((item) => collectJson(item, output)); return; } if (!isRecord(value)) return; output.push(value); if (Array.isArray(value["@graph"])) value["@graph"].forEach((item) => collectJson(item, output)); }
function jsonLdItemListCandidates(html: string): PortalRecord[] { return jsonLdRecords(html).flatMap((record) => { const items = record.itemListElement; if (!Array.isArray(items)) return []; return items.filter(isRecord).map((item) => isRecord(item.item) ? item.item : item).filter(isRecord); }); }
function nextData(html: string): PortalRecord | null { const match = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/iu); if (!match) return null; try { const value = JSON.parse(decodeEntities(match[1])); return isRecord(value) ? value : null; } catch { return null; } }
function namedJson(html: string, name: string): PortalRecord | null { const match = html.match(new RegExp(`${name}\\s*=\\s*(\\{[\\s\\S]*?\\})\\s*;`, "u")); if (!match) return null; try { const value = JSON.parse(match[1]); return isRecord(value) ? value : null; } catch { return null; } }
function hasNextMarker(html: string): boolean { return /(?:rel=["']next["']|data-next-page=["']true["']|["']hasNext(?:Page)?["']\s*:\s*true)/iu.test(html); }
function arrayAt(value: unknown, path: string[]): unknown[] | null { const result = atPath(value, path); return Array.isArray(result) ? result : null; }
function atPath(value: unknown, path: string[]): unknown { let current = value; for (const key of path) { if (!isRecord(current)) return null; current = current[key]; } return current; }
function text(value: PortalRecord, key: string): string | null { return stringValue(value[key]); }
function hasType(value: PortalRecord, ...types: string[]): boolean { const actual = value["@type"]; return typeof actual === "string" ? types.includes(actual) : Array.isArray(actual) && actual.some((item) => typeof item === "string" && types.includes(item)); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function areaFromText(value: unknown): string | null { return stringValue(value)?.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2|mkw)(?![\p{L}])/iu)?.[1] ?? null; }
function roomsFromText(value: unknown): string | null { return stringValue(value)?.match(/(\d+(?:[.,]\d+)?)\s*(?:pokoje?|pok\.)/iu)?.[1] ?? null; }
function decimal(value: unknown): number | null { const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/gu, "").replace(",", ".").replace(/[^0-9.+-]/gu, "")) : null; return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null; }
// Deliberately narrow: only a plausible construction year (not e.g. a stray
// 4-digit price or area fragment) survives this far, since it is already
// pre-validated against the same bounds at extraction time (see
// allegroLokalnieYearBuiltByPath below) -- this is strictly a defensive
// re-check at the one shared boundary every parser's candidate passes
// through, not a second, looser extraction path of its own.
function yearBuiltValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 1700 && value <= 2100 ? value : null; }
function money(value: unknown): number | null { if (typeof value === "number") return Number.isFinite(value) ? value : null; if (typeof value !== "string") return null; const normalized = value.replace(/\s/gu, "").replace(/zł|pln/giu, ""); const parsed = /^\d{1,3}(?:\.\d{3})+$/.test(normalized) ? Number(normalized.replace(/\./gu, "")) : Number(normalized.replace(/,/gu, ".")); return Number.isFinite(parsed) ? parsed : null; }
function imageValues(value: unknown): string[] { const values = Array.isArray(value) ? value : [value]; return values.flatMap((item) => typeof item === "string" ? [item] : isRecord(item) ? [stringValue(item.url) ?? stringValue(item.contentUrl)].filter((url): url is string => Boolean(url)) : []).filter((url) => /^https?:\/\//iu.test(url)).slice(0, 10); }
function stripHtml(value: string): string { return value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim(); }
function decodeEntities(value: string): string { return value.replace(/&quot;/gu, '"').replace(/&#34;/gu, '"').replace(/&amp;/gu, "&").replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">"); }
function isRecord(value: unknown): value is PortalRecord { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const SOURCE_HOSTS: Record<ExternalSourceId, string> = { gratka: "gratka.pl", nieruchomosci_online: "nieruchomosci-online.pl", domiporta: "domiporta.pl", sprzedajemy: "sprzedajemy.pl", adresowo: "adresowo.pl", oferty_net: "oferty.net", bezposrednio: "bezposrednio.net.pl", domy: "domy.pl", allegro_lokalnie: "allegrolokalnie.pl" };
