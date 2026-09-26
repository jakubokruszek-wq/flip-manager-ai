import assert from "node:assert/strict";
import test from "node:test";
import { mapOtodomListing, type OtodomListing } from "./otodom.parser.ts";
import { isPropertyImportError } from "../errors.ts";

// Real production bug: a manually imported Otodom offer could end up with an
// invalid/wrong link -- Otodom's own embedded __NEXT_DATA__ "ad.url" field
// was trusted verbatim, with no check that it was a real, single-offer URL.
// mapOtodomListing() now resolves originalUrl through the same
// isConfirmedOtodomOfferUrl gate the search/scan path already uses (see
// otodom-search.test.ts), falling back to the URL that was actually fetched,
// and refusing the import outright -- never a fake/placeholder link -- when
// neither candidate can be confirmed.
function listing(overrides: Partial<OtodomListing> = {}): OtodomListing {
  return {
    title: "Mieszkanie testowe",
    url: null,
    description: null,
    attributes: {},
    target: {},
    characteristics: [],
    images: [],
    location: {},
    ...overrides,
  };
}

const FALLBACK = "https://www.otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS";

test("a real, valid single-offer url field from Otodom's own payload is kept", () => {
  const property = mapOtodomListing(listing({ url: "https://www.otodom.pl/pl/oferta/inne-mieszkanie-ID4CKQu" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/inne-mieszkanie-ID4CKQu");
});

test("a mobile-style (no www.) url field is still confirmed and normalized", () => {
  const property = mapOtodomListing(listing({ url: "https://otodom.pl/pl/oferta/inne-mieszkanie-ID4CKQu" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/inne-mieszkanie-ID4CKQu");
});

test("tracking query params are stripped from the stored link", () => {
  const property = mapOtodomListing(listing({ url: "https://www.otodom.pl/pl/oferta/inne-mieszkanie-ID4CKQu?utm_source=fb&fbclid=abc" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/inne-mieszkanie-ID4CKQu");
});

test("a search-results url field is never trusted; the fetched (fallback) offer url is used instead", () => {
  const property = mapOtodomListing(listing({ url: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodzkie/lodz/lodz/lodz" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS");
});

test("a category url field is never trusted; the fetched (fallback) offer url is used instead", () => {
  const property = mapOtodomListing(listing({ url: "https://www.otodom.pl/sprzedaz/mieszkanie/lodz/" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS");
});

test("a url field missing an offer identifier is never trusted; the fetched (fallback) offer url is used instead", () => {
  const property = mapOtodomListing(listing({ url: "https://www.otodom.pl/pl/oferta/mieszkanie-bez-id" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS");
});

test("a literal, unsubstituted [lang] route placeholder is never trusted; the fetched (fallback) offer url is used instead", () => {
  const property = mapOtodomListing(listing({ url: "https://www.otodom.pl/[lang]/oferta/inne-mieszkanie-ID4CKQu" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS");
});

test("a malformed url field is never trusted; the fetched (fallback) offer url is used instead", () => {
  const property = mapOtodomListing(listing({ url: "not a url at all" }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS");
});

test("a missing url field falls back cleanly to the fetched offer url", () => {
  const property = mapOtodomListing(listing({ url: null }), FALLBACK);
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/mieszkanie-testowe-ID4CRDS");
});

// The exact real-case regression: an existing listing whose only two URL
// candidates (the payload's own "ad.url" and the fetched/fallback URL) are
// BOTH unconfirmable. The import must fail with a specific, diagnostic
// error -- never silently save a fake or blank link.
test("when neither the payload url nor the fetched url can be confirmed, the import is refused rather than saving a bad link", () => {
  assert.throws(
    () => mapOtodomListing(listing({ url: "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz" }), "https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz"),
    (error: unknown) => {
      assert.ok(isPropertyImportError(error));
      assert.equal((error as { code: string }).code, "INVALID_URL");
      assert.match((error as Error).message, /Nie udało się potwierdzić prawidłowego adresu oferty Otodom/);
      return true;
    },
  );
});

test("a redirect to a confirmed offer url (the fallback reflects the final, resolved location) is accepted", () => {
  // fetchListingHtml resolves redirects before mapOtodomListing ever runs, so
  // the fallback URL passed in here already reflects the final location --
  // this proves that final, confirmed URL is what gets stored.
  const property = mapOtodomListing(listing({ url: null }), "https://www.otodom.pl/pl/oferta/po-przekierowaniu-ID9Z9Z9");
  assert.equal(property.originalUrl, "https://otodom.pl/pl/oferta/po-przekierowaniu-ID9Z9Z9");
});
