import { load } from "cheerio";
import type { PropertySourceListing } from "@/features/properties/types/property";
import { calculateContentHash } from "./otodom-search";
import type { ExternalSourceConfig, ExternalSourceId } from "./external-source-parser";
import { SourceBatchYield, type RadarDetailCursor, type RadarDetailDiagnostic, type SourceBatchContext } from "./source-batches";
import { resolveBuildingType, resolveOwnership } from "./listing-attribute-extraction";
import { invalidSalePriceWarning } from "./sale-price";
import { extractListingIdentityEvidence } from "./identity-evidence";
import { inspectRadarFinishEvidence, isRadarRentalTransactionText, preflightRadarCandidateRejection } from "@/features/price-radar/qualification";

export type ExternalPortalPage = { listings: PropertySourceListing[]; detailCandidates?: PropertySourceListing[]; hasNextPage: boolean; invalidSalePriceCount?: number };
type PortalRecord = Record<string, unknown>;
type PortalCandidate = { id?: unknown; url?: unknown; title?: unknown; description?: unknown; price?: unknown; area?: unknown; rooms?: unknown; floor?: unknown; city?: unknown; district?: unknown; images?: unknown; publishedAt?: unknown; yearBuilt?: unknown; buildingType?: unknown; ownership?: unknown; marketType?: unknown; propertyType?: unknown; sourceRecord?: unknown };
type PortalParser = (html: string, fallbackCity: string) => ExternalPortalPage;

const MAX_PAGES = 5;
const RADAR_DETAIL_PAGE_LIMIT_PER_PORTION = 3;
const RADAR_DETAIL_REQUEST_TIMEOUT_MS = 8_000;
const RADAR_DETAIL_SOURCES = new Set<ExternalSourceId>(["oferty_net", "domiporta"]);
const TRACKING_PARAM = /^(utm_|fbclid|gclid|dclid|msclkid|yclid|ref$)/iu;

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

export type ExternalPortalCriteria = { city: string | null; areaMin?: number | null; areaMax?: number | null; rooms?: readonly number[] };

export async function fetchExternalPortal(config: ExternalSourceConfig, criteria: ExternalPortalCriteria, signal?: AbortSignal, batches?: SourceBatchContext): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  if (batches?.purpose === "price_radar" && RADAR_DETAIL_SOURCES.has(config.id)) {
    return fetchRadarPortalDetails(config, criteria, signal, batches);
  }
  const ofertyLocation = config.id === "oferty_net" && !batches?.ofertyNetLegacySearch ? await resolveOfertyNetLocation(config, criteria.city ?? "", signal) : null;
  const parser = EXTERNAL_PORTAL_PARSERS[config.id];
  const listings: PropertySourceListing[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let fetched = 0;
  for (let page = batches?.cursor || 1; page <= MAX_PAGES; page += 1) {
    if (signal?.aborted) throw new Error(`${config.label}: request aborted.`);
    const url = pageUrl(config, criteria, page, ofertyLocation, batches?.ofertyNetLegacySearch);
    const response = await fetchExternalPage(url, signal);
    if (!response.ok) throw new Error(`${config.label}: HTTP ${response.status}.`);
    const parsed = parser(await response.text(), criteria.city ?? "");
    const pageWarnings = [invalidSalePriceWarning(parsed.invalidSalePriceCount ?? 0)].filter((warning): warning is string => Boolean(warning));
    if (parsed.hasNextPage && page === MAX_PAGES) pageWarnings.push(publicSearchPageLimitWarning(config));
    if (batches) {
      await batches.onBatch({ listings: parsed.listings, warnings: pageWarnings, fetched: parsed.listings.length + (parsed.invalidSalePriceCount ?? 0) }, parsed.hasNextPage && page < MAX_PAGES ? page + 1 : null);
    }
    fetched += parsed.listings.length + (parsed.invalidSalePriceCount ?? 0);
    warnings.push(...pageWarnings);
    for (const listing of parsed.listings) {
      const identity = `${listing.source}:${listing.externalListingId}:${listing.normalizedUrl}`;
      if (!seen.has(identity)) { seen.add(identity); listings.push(listing); }
    }
    if (!parsed.hasNextPage) break;
  }
  if (!listings.length) warnings.push(`${config.label}: odpowiedź nie zawiera zweryfikowanych ofert sprzedaży.`);
  return { listings, warnings: [...new Set(warnings)], fetched };
}

async function fetchRadarPortalDetails(config: ExternalSourceConfig, criteria: ExternalPortalCriteria, signal: AbortSignal | undefined, batches: SourceBatchContext): Promise<{ listings: PropertySourceListing[]; warnings: string[]; fetched: number }> {
  const parser = EXTERNAL_PORTAL_PARSERS[config.id];
  const city = criteria.city ?? "";
  const ofertyLocation = config.id === "oferty_net" && !batches.ofertyNetLegacySearch ? await resolveOfertyNetLocation(config, city, signal) : null;
  const cursor: RadarDetailCursor = batches.radarDetailCursor ?? { kind: "radar_detail_v1", page: batches.cursor ?? 1, candidateIndex: 0 };
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
      const baseListing = candidates[candidateIndex]!;
      const detailUrl = absoluteUrl(baseListing.originalUrl, config.id);
      const next = candidateIndex + 1 < candidates.length
        ? radarDetailCursor(page, candidateIndex + 1)
        : parsed.hasNextPage && page < MAX_PAGES ? radarDetailCursor(page + 1, 0) : null;
      let detailListing: PropertySourceListing | null = null;
      const candidateWarnings: string[] = [];
      if (parsed.hasNextPage && page === MAX_PAGES && candidateIndex === candidates.length - 1) candidateWarnings.push(publicSearchPageLimitWarning(config));
      const candidateFetched = 1;
      let detailDiagnostic: RadarDetailDiagnostic | undefined;

      const preflightRejection = preflightRadarCandidateRejection({
        title: baseListing.title,
        description: baseListing.description,
        buildingType: baseListing.buildingType,
        propertyType: typeof baseListing.rawPayload.propertyType === "string" ? baseListing.rawPayload.propertyType : null,
        rawPayload: baseListing.rawPayload,
      });
      if (preflightRejection) {
        fetched += candidateFetched;
        await batches.onBatch({ listings: [], warnings: [], fetched: candidateFetched, rejectionReasons: [preflightRejection] }, next);
        continue;
      }

      if (detailUrl) {
        let detailResponse: Response;
        try {
          detailResponse = await fetchExternalPage(detailUrl, signal, RADAR_DETAIL_REQUEST_TIMEOUT_MS);
        } catch (error) {
          detailDiagnostic = {
            kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl: null, httpStatus: null, identity: "not_checked",
            unconfirmedFields: [], contradictoryFields: [], errorCode: isTimeoutError(error) ? "TIMEOUT" : "NETWORK_ERROR",
          };
          await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [detailDiagnostic] }, radarDetailCursor(page, candidateIndex));
          throw error;
        }
        if (detailResponse.status === 404 || detailResponse.status === 410) {
          // A listing removed between results and details is not a source outage and must not be qualified from stale card data.
          detailDiagnostic = {
            kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl: detailResponse.url || detailUrl, httpStatus: detailResponse.status,
            identity: "unconfirmed", unconfirmedFields: [], contradictoryFields: [], errorCode: detailResponse.status === 404 ? "NOT_FOUND" : "GONE",
          };
        } else if (!detailResponse.ok) {
          detailDiagnostic = {
            kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl: detailResponse.url || detailUrl, httpStatus: detailResponse.status,
            identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: "HTTP_ERROR",
          };
          await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [detailDiagnostic] }, radarDetailCursor(page, candidateIndex));
          throw new Error(`${config.label}: HTTP ${detailResponse.status} (detail).`);
        } else {
          const detailHtml = await detailResponse.text();
          try {
            assertNotAccessChallenge(config.label, detailHtml);
          } catch (error) {
            detailDiagnostic = {
              kind: "detail_fetch_failed", listingUrl: detailUrl, finalUrl: detailResponse.url || detailUrl, httpStatus: detailResponse.status,
              identity: "not_checked", unconfirmedFields: [], contradictoryFields: [], errorCode: "ACCESS_CHALLENGE",
            };
            await batches.onBatch({ listings: [], warnings: [], fetched: 0, diagnostics: [detailDiagnostic] }, radarDetailCursor(page, candidateIndex));
            throw error;
          }
          const detail = parseRadarOfferDetail(config.id as "oferty_net" | "domiporta", detailHtml);
          const finalUrl = detailResponse.url || detailUrl;
          const identity = compareRadarDetailIdentity(config.id as "oferty_net" | "domiporta", baseListing, detailUrl, finalUrl);
          if (identity === "mismatch") {
            detailDiagnostic = {
              kind: "detail_identity_mismatch", listingUrl: detailUrl, finalUrl, httpStatus: detailResponse.status, identity,
              unconfirmedFields: ["identity"], contradictoryFields: ["identity"],
            };
            detailListing = withUnconfirmedRadarDetail(baseListing);
          } else {
            if (detail.active) detailListing = mergeRadarDetail(baseListing, detail);
            if (!detail.verified || detail.unconfirmedFields.length > 0 || detail.contradictoryFields.length > 0) {
              detailDiagnostic = {
                kind: "detail_not_confirmed", listingUrl: detailUrl, finalUrl, httpStatus: detailResponse.status, identity,
                unconfirmedFields: detail.unconfirmedFields, contradictoryFields: detail.contradictoryFields,
              };
            }
          }
        }
      } else {
        candidateWarnings.push(`DETAIL_URL_INVALID:${baseListing.externalListingId}`);
        detailDiagnostic = {
          kind: "detail_fetch_failed", listingUrl: baseListing.originalUrl || null, finalUrl: null, httpStatus: null, identity: "not_checked",
          unconfirmedFields: [], contradictoryFields: [], errorCode: "INVALID_DETAIL_URL",
        };
      }

      fetched += candidateFetched;
      warnings.push(...candidateWarnings);
      if (detailListing) {
        const identity = `${detailListing.source}:${detailListing.externalListingId}:${detailListing.normalizedUrl}`;
        if (!seen.has(identity)) { seen.add(identity); listings.push(detailListing); }
      }
      await batches.onBatch({ listings: detailListing ? [detailListing] : [], warnings: candidateWarnings, fetched: candidateFetched, ...(detailDiagnostic ? { diagnostics: [detailDiagnostic] } : {}) }, next);
      detailPagesThisPortion += 1;
      if (detailPagesThisPortion >= RADAR_DETAIL_PAGE_LIMIT_PER_PORTION && next !== null) {
        throw new SourceBatchYield("detail_batch_limit");
      }
    }

    if (!parsed.hasNextPage || page >= MAX_PAGES) break;
  }

  if (!sawCandidates) warnings.push(`${config.label}: brak ofert z prawidłowym adresem szczegółów.`);
  return { listings, warnings: [...new Set(warnings)], fetched };
}

function radarDetailCursor(page: number, candidateIndex: number): RadarDetailCursor {
  return { kind: "radar_detail_v1", page, candidateIndex };
}

async function fetchExternalPage(url: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (signal?.aborted) throw new Error("external source request aborted.");
    response = await fetch(url, { cache: "no-store", headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "User-Agent": "FlipManager/1.0" }, redirect: "follow", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
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

type ParsedRadarPortalDetail = {
  active: boolean;
  verified: boolean;
  unconfirmedFields: string[];
  contradictoryFields: string[];
  price: number | null;
  area: number | null;
  rooms: number | null;
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
export function parseRadarOfferDetail(source: "oferty_net" | "domiporta", html: string): ParsedRadarPortalDetail {
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
  const location = source === "oferty_net" ? $(".header h1").first().text() : $(".summary__location").first().text();
  const locationText = location.replace(/\s+/gu, " ").trim() || null;
  const { city, district } = parseRadarLocation(location);
  const titleText = [$("title").first().text(), $("h1").first().text(), source === "oferty_net" ? $(".header span").first().text() : ""].join(" ");
  const detailDescription = source === "domiporta"
    ? $(".description__container").first().text()
    : $(".description, .offer_description, .offer-description, [itemprop='description']").first().text();

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
  const normalizedFinishText = normalizeDetailLabel(finishText);
  const unfinishedEvidence = /stan deweloperski|do wykonczenia|do remontu|wymaga remontu/u.test(normalizedFinishText);
  // Detail verification means the source explicitly states a finish/condition
  // fact. Qualification still decides whether that fact meets Radar's stricter
  // market-specific renovation/turnkey rules.
  const finishStatusConfirmed = finish.fullRenovation || finish.turnkey || unfinishedEvidence;
  const verified = active && price !== null && price > 0 && area !== null && area > 0 && city === "Łódź" && Boolean(district) && Boolean(buildingType) && Boolean(marketType) && propertyType === "apartment" && finishStatusConfirmed;
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
  else if (marketType === "secondary") {
    if (!finish.fullRenovation) unconfirmedFields.push("renovation_completion");
    if (!finish.freshFullRenovation) unconfirmedFields.push("renovation_recency");
    if (!finish.moveInReady) unconfirmedFields.push("move_in_readiness");
  } else if (marketType === "primary" && !finish.turnkey) unconfirmedFields.push("turnkey_finish");
  else if (!marketType && !positiveFinishEvidence) unconfirmedFields.push("finish_evidence");
  if (!active) contradictoryFields.push("active_listing");
  return { active, verified, unconfirmedFields, contradictoryFields, price, area, rooms, city, district, locationText, buildingType, marketType, propertyType, description };
}

function withUnconfirmedRadarDetail(base: PropertySourceListing): PropertySourceListing {
  return { ...base, rawPayload: { ...base.rawPayload, detailAttempted: true, detailVerified: false } };
}

function compareRadarDetailIdentity(source: "oferty_net" | "domiporta", listing: PropertySourceListing, requestedUrl: string, finalUrl: string): RadarDetailDiagnostic["identity"] {
  const normalizeUrl = (value: string): string | null => {
    try {
      const url = new URL(value);
      url.search = "";
      url.hash = "";
      url.pathname = url.pathname.replace(/\.html?$/iu, "").replace(/\/$/u, "");
      return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase()}`;
    } catch { return null; }
  };
  if (normalizeUrl(requestedUrl) && normalizeUrl(requestedUrl) === normalizeUrl(finalUrl)) return "same_url";
  const idFromUrl = (value: string): string | null => {
    const id = source === "oferty_net" ? ofertyNetIdFromUrl(value) : lastPathSegmentId(value);
    return id?.replace(/\.html?$/iu, "").toLowerCase() ?? null;
  };
  const expectedId = listing.externalListingId || idFromUrl(requestedUrl);
  const responseId = idFromUrl(finalUrl);
  if (expectedId && responseId) return expectedId.toLowerCase() === responseId ? "same_listing_id" : "mismatch";
  return "unconfirmed";
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError" || /timed?\s*out|timeout/iu.test(error.message);
}

function mergeRadarDetail(base: PropertySourceListing, detail: ParsedRadarPortalDetail): PropertySourceListing {
  const raw = { ...base.rawPayload };
  const candidate = isRecord(raw.candidate) ? raw.candidate : {};
  const mergedCandidate = {
    ...candidate,
    price: detail.price ?? base.price,
    area: detail.area ?? base.area,
    rooms: detail.rooms ?? base.rooms,
    city: detail.city,
    district: detail.district,
    buildingType: detail.buildingType,
    marketType: detail.marketType,
    propertyType: detail.propertyType,
    detailAttempted: true,
    detailVerified: detail.verified,
    detailLocationText: detail.locationText,
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
    city: detail.city,
    district: detail.district,
    locationText: [detail.district, detail.city].filter(Boolean).join(", ") || null,
    buildingType: resolveBuildingType(detail.buildingType, base.title, description),
    description,
    rawPayload: { source: base.source, candidate: mergedCandidate, marketType: detail.marketType, propertyType: detail.propertyType, detailAttempted: true, detailVerified: detail.verified, detailLocationText: detail.locationText },
  };
}

function parseRadarLocation(value: string): { city: string | null; district: string | null } {
  const parts = value.split(/[,;|\n]+/u).map(normalizeDetailLabel).filter(Boolean);
  const city = parts.some((part) => part === "lodz" || part.startsWith("lodz ")) ? "\u0141\u00f3d\u017a" : null;
  const districts: Array<[string, string]> = [["baluty", "Ba\u0142uty"], ["gorna", "G\u00f3rna"], ["polesie", "Polesie"], ["srodmiescie", "\u015ar\u00f3dmie\u015bcie"], ["widzew", "Widzew"]];
  const tokens = new Set(parts.flatMap((part) => part.split(" ")));
  const district = districts.find(([key]) => tokens.has(key))?.[1] ?? null;
  return { city, district };
}

function parseMarketType(primaryValue: string | null, marketValue: string | null): "primary" | "secondary" | null {
  const primary = normalizeDetailLabel(primaryValue ?? "");
  if (["tak", "yes", "1"].includes(primary)) return "primary";
  if (["nie", "no", "0"].includes(primary)) return "secondary";
  const market = normalizeDetailLabel(marketValue ?? "");
  if (/pierwotny|deweloperski/u.test(market)) return "primary";
  if (/wtorny/u.test(market)) return "secondary";
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
    const cardText = card.text().replace(/\s+/gu, " ").trim();
    const image = card.find("img").first();
    const href = card.find("a[href]").filter((__, link) => ($(link).attr("href") ?? "").includes("/o/")).first().attr("href") ?? card.find("a[href]").first().attr("href");
    const price = cardText.match(/([\d\s\u00a0.,]+)\s*(?:zł|pln)\b/iu)?.[1];
    const area = cardText.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2|mkw)(?![\p{L}])/iu)?.[1];
    const rooms = cardText.match(/(\d+(?:[.,]\d+)?)\s*pok\./iu)?.[1];
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
      district: locationTitle.match(/,\s*([^,]+)$/u)?.[1]?.trim(),
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

// Real public structure, confirmed against szybko.pl's own GET search form
// (read-only, 2026-10-03): the previously registered <city>/mieszkania/sprzedaz
// path 302-redirects to the homepage -- an outright wrong path, not just an
// unfiltered one. The site's real form (id="formSearch", action="/form",
// method="GET") reveals the working pattern once submitted:
// /l/na-sprzedaz/lokal-mieszkalny/<city>, confirmed genuinely city-scoped
// (465 ofert for "lodz"/"Łódź" vs 63622+ nationwide; a plain ASCII slug is
// accepted, no diacritics required). That page has no JSON-LD or
// __NEXT_DATA__ at all (the previous parser's ItemList assumption never
// matched anything real) -- listings are schema.org Microdata
// (itemscope/itemprop on the rendered HTML itself), a third, distinct shape
// from every other portal in this file, so it needs its own cheerio-based
// extraction rather than a JSON record mapper.
function parseSzybko(html: string, fallbackCity: string): ExternalPortalPage {
  const $ = load(html);
  const candidates: PortalCandidate[] = [];
  $("[data-assetid]").each((_, element) => {
    const card = $(element);
    const [city, district] = parseSzybkoAddress(card.find(".popup-gmaps").first().text());
    candidates.push({
      id: card.attr("data-assetid"),
      url: card.find(".listing-title-heading[href]").first().attr("href"),
      title: card.find("[itemprop='name']").first().text() || card.find(".listing-title-heading").first().text(),
      description: card.find("[itemprop='description']").first().text(),
      price: card.find("[itemprop='price']").first().attr("content"),
      area: areaFromText(card.find(".asset-feature.area").first().text()),
      rooms: card.find(".asset-feature.rooms").first().text(),
      city: city ?? fallbackCity,
      district,
      images: card.find("[itemprop='image']").first().attr("href"),
    });
  });
  return fromCandidates("szybko", candidates, fallbackCity, hasNextMarker(html));
}

// "Łódź (Widzew) (Łódzkie, gm. Łódź)" -> city "Łódź", district "Widzew".
// Sampled across a full result page: the city-plus-district prefix before
// the first parenthesis is consistent even when the voivodeship/street
// suffix that follows it varies ("(Łódzkie, gm. Łódź)" vs ", <street>").
function parseSzybkoAddress(value: string): [string | null, string | null] {
  const match = value.replace(/\s+/gu, " ").trim().match(/^([^(]+?)\s*\(([^)]+)\)/u);
  return match ? [stringValue(match[1]), stringValue(match[2])] : [stringValue(value), null];
}

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

const SOURCE_HOSTS: Record<ExternalSourceId, string> = { gratka: "gratka.pl", nieruchomosci_online: "nieruchomosci-online.pl", domiporta: "domiporta.pl", sprzedajemy: "sprzedajemy.pl", adresowo: "adresowo.pl", oferty_net: "oferty.net", szybko: "szybko.pl", bezposrednio: "bezposrednio.net.pl", domy: "domy.pl", allegro_lokalnie: "allegrolokalnie.pl" };
