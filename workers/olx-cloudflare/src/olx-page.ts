import { isOlxChallengeHtml, parseOlxHtml, type OlxParseResult } from "../../../features/flip-finder/olx-parser.ts";
import type { PropertySourceListing } from "../../../features/properties/types/property.ts";
import { applyListingFixes, type ListingFixOptions, type ListingFixReport } from "./listing-fixes.ts";

/**
 * OLX page → Finder listings, with as little Worker CPU as possible.
 *
 * Workers Free allows ~10 ms of CPU per invocation, while normalising one OLX
 * results page with the Finder parser costs ~8–12 ms (text analysis of every
 * description, content hashes, image URLs). Browser CPU is not Worker CPU, so
 * the whole pipeline runs inside the Browser Run page:
 *
 *   1. `EXTRACT_IN_PAGE_SOURCE` locates the original inline
 *      `window.__PRERENDERED_STATE__` literal, decodes it and keeps only
 *      `listing.listing.ads` plus OLX's own counters and the rendered card count;
 *   2. `processExtractedPage` (bundled into the page by
 *      scripts/build-in-page-bundle.mjs) rebuilds a minimal state envelope and
 *      runs the unchanged Finder parser (`parseOlxHtml`) on it, then verifies
 *      the result;
 *   3. the page returns one string: a small JSON header, a newline, and the
 *      listings JSON, which the Worker forwards to /complete without parsing it.
 *
 * The same functions run in Node for tests (the Worker never parses listings).
 */

export type ExtractedOlxPage = {
  title: string;
  finalUrl: string;
  htmlLength: number;
  marker: boolean;
  challenge: boolean;
  /** Listing cards rendered in the DOM (`[data-cy="l-card"]`), or null when the selector is absent. */
  domCards: number | null;
  stateSource: "inline-script" | "window" | null;
  /** JSON text of `listing.listing.ads` or null when that path is not an array. */
  adsJson: string | null;
  adsShape: string;
  stateError: string | null;
  meta: { totalElements: number | null; visibleTotalCount: number | null; totalPages: number | null; pageNumber: number | null };
};

/**
 * Self-contained browser-side source. It is a string (not a function) on
 * purpose: bundlers (wrangler's esbuild with keepNames) inject helpers into
 * function bodies, which do not exist inside the OLX page.
 * `isChallenge` is the Finder parser's own detector.
 */
export const EXTRACT_IN_PAGE_SOURCE = String.raw`(function (isChallenge) {
  var MARKER = "window.__PRERENDERED_STATE__";
  var root = document.documentElement;
  var html = root ? root.outerHTML : "";
  var out = {
    title: document.title || "", finalUrl: String(location.href), htmlLength: html.length,
    marker: html.indexOf(MARKER) >= 0, challenge: Boolean(isChallenge(html)),
    domCards: null, stateSource: null, adsJson: null, adsShape: "missing", stateError: null,
    meta: { totalElements: null, visibleTotalCount: null, totalPages: null, pageNumber: null }
  };
  var cards = document.querySelectorAll('[data-cy="l-card"]');
  out.domCards = cards.length > 0 ? cards.length : (document.querySelector('[data-testid="listing-grid"]') ? 0 : null);
  var state = null;
  var scripts = document.getElementsByTagName("script");
  for (var s = 0; s < scripts.length && state === null; s += 1) {
    var text = scripts[s].textContent || "";
    var markerIndex = text.indexOf(MARKER);
    if (markerIndex < 0) continue;
    var quote = text.indexOf('"', markerIndex + MARKER.length);
    if (quote < 0) { out.stateError = "OLX_STATE_LITERAL_START_MISSING"; break; }
    var escaped = false, end = -1;
    for (var i = quote + 1; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (ch === '"' && !escaped) { end = i; break; }
      escaped = ch === "\\" && !escaped;
    }
    if (end < 0) { out.stateError = "OLX_STATE_LITERAL_UNTERMINATED"; break; }
    try { state = JSON.parse(JSON.parse(text.slice(quote, end + 1))); out.stateSource = "inline-script"; }
    catch (error) { out.stateError = "OLX_STATE_JSON_INVALID"; }
  }
  if (state === null && !out.stateError) {
    var live = window.__PRERENDERED_STATE__;
    try {
      if (typeof live === "string") { state = JSON.parse(live); out.stateSource = "window"; }
      else if (live && typeof live === "object") { state = live; out.stateSource = "window"; }
    } catch (error) { out.stateError = "OLX_STATE_JSON_INVALID"; }
  }
  var listing = state && state.listing && state.listing.listing;
  var ads = listing ? listing.ads : undefined;
  out.adsShape = Array.isArray(ads) ? "array" : ads === null ? "null" : typeof ads;
  if (Array.isArray(ads)) out.adsJson = JSON.stringify(ads);
  if (listing && typeof listing === "object") {
    var keys = ["totalElements", "visibleTotalCount", "totalPages", "pageNumber"];
    for (var k = 0; k < keys.length; k += 1) {
      var value = Number(listing[keys[k]]);
      out.meta[keys[k]] = listing[keys[k]] !== null && listing[keys[k]] !== undefined && isFinite(value) ? value : null;
    }
  }
  return JSON.stringify(out);
})`;

/** Extraction only (tests, diagnostics): the page returns the ExtractedOlxPage JSON. */
export function extractionExpression(): string {
  // `__name` is defined in case a future bundler config injects it into the inlined detector.
  return `(function () { var __name = function (target) { return target; }; return ${EXTRACT_IN_PAGE_SOURCE}(${isOlxChallengeHtml.toString()}); })()`;
}

export function decodeExtractedPage(json: unknown): ExtractedOlxPage {
  if (typeof json !== "string") throw new Error("OLX_CLOUD_EXTRACTION_INVALID");
  const value = JSON.parse(json) as ExtractedOlxPage;
  if (!value || typeof value !== "object" || typeof value.marker !== "boolean") throw new Error("OLX_CLOUD_EXTRACTION_INVALID");
  return value;
}

/** Minimal page carrying only the ads array, in the exact encoding OLX uses. */
export function buildStateEnvelope(adsJson: string): string {
  const stateJson = `{"listing":{"listing":{"ads":${adsJson}}}}`;
  return `<script>window.__PRERENDERED_STATE__ = ${JSON.stringify(stateJson)};</script>`;
}

export type FieldCoverage = Record<"url" | "price" | "area" | "rooms" | "district" | "publishedAt" | "buildingType", number>;

export type OlxVerification = {
  rawItems: number;
  normalizedItems: number;
  uniqueIds: number;
  domCards: number | null;
  meta: ExtractedOlxPage["meta"];
  coverage: FieldCoverage;
  warnings: string[];
};

const REQUIRED_FIELDS = ["url", "price", "area"] as const;
const OPTIONAL_FIELDS = ["rooms", "district", "publishedAt", "buildingType"] as const;
const FIELD_LABELS: Record<keyof FieldCoverage, string> = {
  url: "URL", price: "cena", area: "metraż", rooms: "pokoje", district: "dzielnica", publishedAt: "data publikacji", buildingType: "typ budynku",
};

/**
 * Checks the parsed result against what the page itself claims: number of
 * rendered cards, OLX's own counters, duplicate ids and coverage of the
 * fields Finder relies on. Problems become scan warnings (visible in Finder),
 * never silent drops.
 */
export function verifyOlxResult(page: ExtractedOlxPage, parsed: OlxParseResult): OlxVerification {
  const listings = parsed.listings as PropertySourceListing[];
  const coverage: FieldCoverage = {
    url: count(listings, (item) => Boolean(item.originalUrl)),
    price: count(listings, (item) => typeof item.price === "number" && item.price > 0),
    area: count(listings, (item) => typeof item.area === "number" && item.area > 0),
    rooms: count(listings, (item) => typeof item.rooms === "number"),
    district: count(listings, (item) => Boolean(item.district)),
    publishedAt: count(listings, (item) => Boolean(item.publishedAt)),
    buildingType: count(listings, (item) => Boolean(item.buildingType)),
  };
  const uniqueIds = new Set(listings.map((item) => item.externalListingId)).size;
  const warnings: string[] = [];
  const n = parsed.normalizedItems;

  if (page.domCards !== null && page.domCards !== parsed.rawItems) {
    warnings.push(`OLX_CLOUD_COUNT_MISMATCH: ${parsed.rawItems} ofert w PRERENDERED_STATE, ${page.domCards} kart na stronie.`);
  }
  if (parsed.normalizedItems < parsed.rawItems) {
    warnings.push(`OLX_CLOUD_NORMALIZATION_DROPPED: ${parsed.rawItems - parsed.normalizedItems} z ${parsed.rawItems} ofert bez URL lub identyfikatora.`);
  }
  if (uniqueIds < n) warnings.push(`OLX_CLOUD_DUPLICATE_IDS: ${n - uniqueIds} powtórzonych identyfikatorów ofert.`);
  const { totalElements, totalPages, pageNumber } = page.meta;
  if (parsed.rawItems === 0 && totalElements !== null && totalElements > 0) {
    warnings.push(`OLX_CLOUD_EMPTY_DESPITE_TOTAL: OLX deklaruje ${totalElements} ofert, a lista strony jest pusta.`);
  }
  if (totalPages !== null && pageNumber !== null && pageNumber < totalPages && parsed.rawItems > 0 && parsed.rawItems < 10) {
    warnings.push(`OLX_CLOUD_SHORT_PAGE: tylko ${parsed.rawItems} ofert na stronie ${pageNumber}/${totalPages}.`);
  }
  if (n > 0) {
    const weakRequired = REQUIRED_FIELDS.filter((field) => coverage[field] / n < 0.9);
    // Optional OLX params are often missing; only a total absence on a full page suggests a shape change.
    const absentOptional = n >= 5 ? OPTIONAL_FIELDS.filter((field) => coverage[field] === 0) : [];
    if (weakRequired.length || absentOptional.length) {
      warnings.push(`OLX_CLOUD_FIELD_COVERAGE: ${[...weakRequired, ...absentOptional].map((field) => `${FIELD_LABELS[field]} ${coverage[field]}/${n}`).join(", ")}.`);
    }
  }
  return { rawItems: parsed.rawItems, normalizedItems: n, uniqueIds, domCards: page.domCards, meta: page.meta, coverage, warnings };
}

/**
 * Parser input for an extracted page. Throws the same codes as the Finder
 * parser for a missing or changed state. Cloud fixes (stable id, image sizes)
 * are applied before verification, so duplicate checks see the final ids.
 */
export function parseExtractedPage(page: ExtractedOlxPage, fixes: ListingFixOptions = { idMode: "legacy" }): { parsed: OlxParseResult; verification: OlxVerification; fixReport: ListingFixReport } {
  if (page.stateError === "OLX_STATE_JSON_INVALID") throw new Error("OLX: niepoprawny JSON PRERENDERED_STATE.");
  if (!page.marker && page.adsJson === null) throw new Error("OLX: brak PRERENDERED_STATE.");
  if (page.adsJson === null) throw new Error("OLX_PARSER_SHAPE_CHANGED");
  const parsed = withQuietParserLog(() => parseOlxHtml(buildStateEnvelope(page.adsJson as string)));
  const fixReport = applyListingFixes(parsed.listings as PropertySourceListing[], fixes);
  const verification = verifyOlxResult(page, parsed);
  if (fixReport.imagesUnresolved > 0) verification.warnings.push(`OLX_CLOUD_IMAGE_TEMPLATE_UNRESOLVED: ${fixReport.imagesUnresolved} adresów zdjęć z nierozwiązanym szablonem rozmiaru.`);
  // Finder keeps at most 20 warnings per scan; parser warnings go first.
  return { parsed: { ...parsed, warnings: [...parsed.warnings, ...verification.warnings].slice(0, 20) }, verification, fixReport };
}

/**
 * The Finder parser logs its shape probe with console.info. On the envelope
 * that probe describes our envelope, not OLX's page, so it would mislead;
 * the verification object (logged by the caller) replaces it.
 */
function withQuietParserLog<T>(operation: () => T): T {
  const original = console.info;
  console.info = () => undefined;
  try {
    return operation();
  } finally {
    console.info = original;
  }
}

function count<T>(items: T[], predicate: (item: T) => boolean): number {
  let total = 0;
  for (const item of items) if (predicate(item)) total += 1;
  return total;
}

/** Small JSON part of the in-page result; the listings travel separately as raw JSON. */
export type InPageHeader = {
  page: Omit<ExtractedOlxPage, "adsJson">;
  rawItems: number;
  normalizedItems: number;
  warnings: string[];
  verification: OlxVerification | null;
  fixReport: ListingFixReport | null;
  /** Parser error (same messages as the Finder parser) or an unexpected in-page failure; the listings part is then "null". */
  error: string | null;
};

export type InPageOptions = ListingFixOptions;

/**
 * Runs inside the page. Returns `header JSON + "\n" + listings JSON`.
 * JSON.stringify never emits a raw newline, so the first one is the separator.
 * There is deliberately no Worker-side fallback: parsing a page in the Worker
 * costs ~8–12 ms CPU, above the Workers Free per-invocation limit, and an
 * invocation killed for CPU would take its held jobs down with it.
 */
export function processExtractedPage(page: ExtractedOlxPage, options: InPageOptions = { idMode: "legacy" }): string {
  const { adsJson: _adsJson, ...meta } = page;
  void _adsJson;
  try {
    const { parsed, verification, fixReport } = parseExtractedPage(page, options);
    const header: InPageHeader = { page: meta, rawItems: parsed.rawItems, normalizedItems: parsed.normalizedItems, warnings: parsed.warnings, verification, fixReport, error: null };
    return `${JSON.stringify(header)}\n${JSON.stringify(parsed.listings)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const header: InPageHeader = { page: meta, rawItems: 0, normalizedItems: 0, warnings: [], verification: null, fixReport: null, error: message.slice(0, 300) };
    return `${JSON.stringify(header)}\nnull`;
  }
}

/** Finder parser messages (the page itself is not what we expect) vs. anything else (a defect of the in-page pipeline). */
export function isParserError(message: string): boolean {
  return /^(OLX:|OLX_PARSER_SHAPE_CHANGED)/.test(message);
}

export function decodeInPageResult(text: unknown): { header: InPageHeader; second: string } {
  if (typeof text !== "string") throw new Error("OLX_CLOUD_EXTRACTION_INVALID");
  const separator = text.indexOf("\n");
  if (separator < 0) throw new Error("OLX_CLOUD_EXTRACTION_INVALID");
  const header = JSON.parse(text.slice(0, separator)) as InPageHeader;
  if (!header || typeof header !== "object" || !header.page || typeof header.page.marker !== "boolean") throw new Error("OLX_CLOUD_EXTRACTION_INVALID");
  return { header, second: text.slice(separator + 1) };
}
