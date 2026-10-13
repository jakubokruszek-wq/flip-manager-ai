/**
 * Step 1: the Finder parser and the cloud extraction on a representative OLX
 * results page. Runs the in-page extraction in a real (local) Chromium, which
 * is what Browser Run executes remotely.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import vm from "node:vm";

import { isOlxChallengeHtml, parseOlxHtml } from "../../../features/flip-finder/olx-parser.ts";
import { inPageExpression } from "../src/in-page-expression.ts";
import { buildStateEnvelope, decodeExtractedPage, decodeInPageResult, extractionExpression, parseExtractedPage, processExtractedPage, verifyOlxResult, type ExtractedOlxPage } from "../src/olx-page.ts";
import { rawListings, rawListingsJson } from "../src/raw-listings.ts";
import { buildChallengePage, buildOlxListingPage, fixtureAds } from "./fixtures/generate-olx-fixture.ts";
import { localChromium, type LocalChromium } from "./helpers/local-chromium.ts";

const FIXTURE = readFileSync(new URL("./fixtures/olx-lodz-sprzedaz.sample.html", import.meta.url), "utf8");
const OLX_URL = "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/";
console.info = () => undefined; // the Finder parser's shape probe

let chromium: LocalChromium | null = null;
before(async () => { chromium = await localChromium(); });
after(async () => { await chromium?.close(); });

test("the committed fixture is the generator's current output", () => {
  assert.equal(FIXTURE, buildOlxListingPage());
});

test("Finder parser reads the real page structure: count and every field the worker must deliver", () => {
  const result = parseOlxHtml(FIXTURE);
  assert.equal(result.rawItems, 40);
  assert.equal(result.normalizedItems, 40);
  assert.deepEqual(result.warnings, []);

  const first = result.listings[0];
  assert.equal(first.source, "olx");
  assert.equal(first.originalUrl, "https://www.olx.pl/d/oferta/mieszkanie-one-pokoje-baluty-CID3-IDLFLS.html");
  assert.equal(first.price, 250_000);
  assert.equal(first.area, 28);
  assert.equal(first.rooms, 1);
  assert.equal(first.district, "Bałuty");
  assert.equal(first.city, "Łódź");
  assert.equal(first.publishedAt, "2026-10-12T12:00:00.000Z");
  assert.equal(first.buildingType, "blok");
  assert.equal(first.pricePerSqm, 250_000 / 28);

  // Escaped quotes, backslash and "<" (< in the literal) survive both JSON decodes.
  const tenement = result.listings[5];
  assert.equal(tenement.title, "Kamienica \"po remoncie\" — 3/4 piętro, ul. Piotrkowska <120> m² \\ okazja");
  assert.equal(tenement.buildingType, "kamienica");
  assert.equal(tenement.area, 35.5);
  assert.equal(tenement.rooms, 2);

  const relative = result.listings[7];
  assert.equal(relative.externalListingId, "13Ab07");
  assert.equal(relative.originalUrl, "https://www.olx.pl/d/oferta/kawalerka-baluty-CID3-ID13Ab07.html");

  assert.equal(result.listings[9].price, null, "\"Zapytaj o cenę\" has no price, not 0");
  assert.equal(result.listings[11].district, null);
  assert.equal(result.listings[11].buildingType, null);
  assert.equal(result.listings[13].publishedAt, "2026-10-12T12:00:00.000Z", "Unix seconds are accepted");
  assert.equal(new Set(result.listings.map((item) => item.externalListingId)).size, 40);
});

test("the challenge detector inlined into the page is self-contained", () => {
  const detector = vm.runInNewContext(`(${isOlxChallengeHtml.toString()})`, Object.create(null)) as (html: string) => boolean;
  assert.equal(detector(buildChallengePage()), true);
  assert.equal(detector(FIXTURE), false);
});

test("the ads-only envelope yields exactly the listings of the full page", () => {
  const ads = fixtureAds();
  const full = parseOlxHtml(FIXTURE);
  const reduced = parseOlxHtml(buildStateEnvelope(JSON.stringify(ads)));
  assert.deepEqual(reduced, full);
});

test("verification flags count mismatches, dropped ads, empty pages and missing core fields", () => {
  const page = (overrides: Partial<ExtractedOlxPage>): ExtractedOlxPage => ({
    title: "t", finalUrl: OLX_URL, htmlLength: 1, marker: true, challenge: false, domCards: null, stateSource: "inline-script", adsJson: "[]", adsShape: "array", stateError: null,
    meta: { totalElements: null, visibleTotalCount: null, totalPages: null, pageNumber: null }, ...overrides,
  });
  const clean = verifyOlxResult(page({ domCards: 40, meta: { totalElements: 1000, visibleTotalCount: 1847, totalPages: 25, pageNumber: 1 } }), parseOlxHtml(FIXTURE));
  assert.deepEqual(clean.warnings, []);
  assert.deepEqual(clean.coverage, { url: 40, price: 39, area: 40, rooms: 40, district: 39, publishedAt: 40, buildingType: 39 });

  const mismatch = verifyOlxResult(page({ domCards: 52 }), parseOlxHtml(FIXTURE));
  assert.match(mismatch.warnings.join(" "), /OLX_CLOUD_COUNT_MISMATCH: 40 ofert w PRERENDERED_STATE, 52 kart/);

  const noPrice = fixtureAds().map((ad) => ({ ...ad, price: null }));
  const weak = verifyOlxResult(page({}), parseOlxHtml(buildStateEnvelope(JSON.stringify(noPrice))));
  assert.match(weak.warnings.join(" "), /OLX_CLOUD_FIELD_COVERAGE: cena 0\/40/);

  const dropped = verifyOlxResult(page({}), parseOlxHtml(buildStateEnvelope(JSON.stringify([...fixtureAds(), { id: null, url: "https://example.com/x" }]))));
  assert.match(dropped.warnings.join(" "), /OLX_CLOUD_NORMALIZATION_DROPPED: 1 z 41/);

  const empty = verifyOlxResult(page({ meta: { totalElements: 1000, visibleTotalCount: null, totalPages: 25, pageNumber: 1 } }), parseOlxHtml(buildStateEnvelope("[]")));
  assert.match(empty.warnings.join(" "), /OLX_CLOUD_EMPTY_DESPITE_TOTAL/);
});

test("a missing or reshaped state fails with the parser's own error codes", () => {
  const base = { title: "", finalUrl: OLX_URL, htmlLength: 1, challenge: false, domCards: null, stateSource: null, adsShape: "missing", stateError: null, meta: { totalElements: null, visibleTotalCount: null, totalPages: null, pageNumber: null } };
  assert.throws(() => parseExtractedPage({ ...base, marker: false, adsJson: null }), /brak PRERENDERED_STATE/);
  assert.throws(() => parseExtractedPage({ ...base, marker: true, adsJson: null, adsShape: "object" }), /OLX_PARSER_SHAPE_CHANGED/);
  assert.throws(() => parseExtractedPage({ ...base, marker: true, adsJson: null, stateError: "OLX_STATE_JSON_INVALID" }), /niepoprawny JSON/);
});

test("in a real browser: extraction returns only the ads, matching the full-page parse", async (t) => {
  if (!chromium) return t.skip("local Chromium unavailable");
  const extracted = await chromium.extract(OLX_URL, FIXTURE);
  assert.equal(extracted.marker, true);
  assert.equal(extracted.challenge, false);
  assert.equal(extracted.stateSource, "inline-script");
  assert.equal(extracted.domCards, 40);
  assert.deepEqual(extracted.meta, { totalElements: 1000, visibleTotalCount: 1847, totalPages: 25, pageNumber: 1 });
  assert.equal(extracted.title, "Mieszkania na sprzedaż Łódź - OLX.pl");
  // The Worker receives a fraction of the page.
  assert.ok((extracted.adsJson?.length ?? 0) < extracted.htmlLength / 2, `ads ${extracted.adsJson?.length} vs html ${extracted.htmlLength}`);

  const { parsed, verification } = parseExtractedPage(extracted);
  assert.deepEqual(parsed.listings, parseOlxHtml(FIXTURE).listings);
  assert.deepEqual(verification.warnings, []);
});

test("in a real browser: state is read from the original script even if the app deletes the global", async (t) => {
  if (!chromium) return t.skip("local Chromium unavailable");
  const extracted = await chromium.extract(OLX_URL, buildOlxListingPage({ deleteGlobalAfterHydration: true }));
  assert.equal(extracted.stateSource, "inline-script");
  assert.equal(parseExtractedPage(extracted).parsed.normalizedItems, 40);
});

test("in a real browser: a challenge page is recognised and an empty result is reported, not hidden", async (t) => {
  if (!chromium) return t.skip("local Chromium unavailable");
  const challenge = await chromium.extract(OLX_URL, buildChallengePage());
  assert.equal(challenge.challenge, true);
  assert.equal(challenge.marker, false);

  const empty = await chromium.extract(OLX_URL, buildOlxListingPage({ ads: [], totalElements: 0 }));
  const { parsed } = parseExtractedPage(empty);
  assert.equal(parsed.rawItems, 0);
  assert.deepEqual(parsed.warnings, ["OLX zwrócił pustą listę ofert."]);
  assert.equal(empty.domCards, 0);
});

test("decodeExtractedPage rejects anything but the extraction's JSON string", () => {
  assert.throws(() => decodeExtractedPage({}), /OLX_CLOUD_EXTRACTION_INVALID/);
  assert.throws(() => decodeExtractedPage("{}"), /OLX_CLOUD_EXTRACTION_INVALID/);
  assert.equal(typeof extractionExpression(), "string");
});

test("in a real browser: the full in-page pipeline (bundled Finder parser) returns the same listings, with and without page JavaScript", async (t) => {
  if (!chromium) return t.skip("local Chromium unavailable");
  const expected = parseOlxHtml(FIXTURE).listings;
  for (const javaScriptEnabled of [false, true]) {
    const text = await chromium.evaluate(OLX_URL, FIXTURE, inPageExpression(), { javaScriptEnabled });
    const { header, second } = decodeInPageResult(text);
    assert.equal(header.error, null);
    assert.equal(header.rawItems, 40);
    assert.equal(header.normalizedItems, 40);
    assert.deepEqual(header.warnings, []);
    assert.equal(header.page.domCards, 40);
    assert.equal(header.page.stateSource, "inline-script");
    assert.deepEqual(JSON.parse(second), JSON.parse(JSON.stringify(expected)), `javaScriptEnabled=${javaScriptEnabled}`);
    assert.ok(String(text).length < header.page.htmlLength * 2);
  }
});

test("in a real browser: the page is left without globals from the pipeline", async (t) => {
  if (!chromium) return t.skip("local Chromium unavailable");
  const leaked = await chromium.evaluate(OLX_URL, FIXTURE, `(function(){ ${inPageExpression()}; return typeof window.FlipOlxInPage + "," + typeof window.__name; })()`);
  assert.equal(leaked, "undefined,undefined");
});

test("in-page parser errors keep the Finder parser's messages; only unexpected failures ask for a Worker fallback", () => {
  const meta = { title: "", finalUrl: OLX_URL, htmlLength: 1, marker: true, challenge: false, domCards: null, stateSource: "inline-script" as const, adsShape: "object", stateError: null, meta: { totalElements: null, visibleTotalCount: null, totalPages: null, pageNumber: null } };
  const reshaped = decodeInPageResult(processExtractedPage({ ...meta, adsJson: null }));
  assert.equal(reshaped.header.error, "OLX_PARSER_SHAPE_CHANGED");
  assert.equal(reshaped.header.fallback, false);
  assert.equal(reshaped.second, "null");
  const ok = decodeInPageResult(processExtractedPage({ ...meta, adsShape: "array", adsJson: JSON.stringify(fixtureAds()) }));
  assert.equal(ok.header.normalizedItems, 40);
  assert.equal(JSON.parse(ok.second).length, 40);
  assert.throws(() => decodeInPageResult("no separator"), /OLX_CLOUD_EXTRACTION_INVALID/);
});

test("the committed in-page bundle is up to date with the Finder parser", async () => {
  const { buildInPageBundle } = await import("../scripts/build-in-page-bundle.mjs");
  assert.equal(readFileSync(new URL("../src/generated/in-page-bundle.ts", import.meta.url), "utf8"), await buildInPageBundle(), "run: node scripts/build-in-page-bundle.mjs");
});

test("raw listings are never silently serialised as an empty array", () => {
  const holder = rawListings(' [{"a":1}] ');
  assert.equal(rawListingsJson(holder), '[{"a":1}]');
  assert.throws(() => JSON.stringify({ listings: holder }), /OLX_CLOUD_RAW_LISTINGS_REQUIRE_RAW_COMPLETE/);
  assert.throws(() => rawListings("null"), /OLX_CLOUD_LISTINGS_JSON_INVALID/);
  assert.equal(rawListingsJson([]), null);
});
