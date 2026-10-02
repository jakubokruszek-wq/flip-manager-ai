import assert from "node:assert/strict";
import test from "node:test";
import { isConfirmedOtodomOfferUrl, normalizeOtodomUrl } from "./otodom-search.ts";

// Real production bug: Otodom offers showed invalid/wrong listing links.
// listingUrl() (otodom-search-adapter.ts) used to synthesize a fallback URL
// from this row's own raw numeric id/adId/listingId field when no direct
// url/href/link was present -- but Otodom's real single-offer URL suffix is
// a distinct, encoded alphanumeric code (e.g. "-ID4CRDS", "-ID4CKQu", both
// real examples), not necessarily that same numeric database id. That
// fallback is now gone entirely; isConfirmedOtodomOfferUrl is the one place
// that decides whether a URL is safe to keep.
test("a real, valid single-offer Otodom URL is confirmed", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/oferta/3-pokojowe-mieszkanie-po-kapitalnym-remoncie-z-pelnym-wyposazeniem-ID4CRDS"), true);
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/oferta/mieszkanie-kawalerka-do-wynajecia-lodz-centrum-30m-balkon-ID4CKQu"), true);
});

test("a mobile-style Otodom URL (no www.) is still confirmed", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS"), true);
});

test("a true mobile subdomain (m.otodom.pl) is confirmed like any other otodom.pl subdomain", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://m.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS"), true);
});

test("a legacy .html suffix on a real Otodom offer remains confirmed", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS.html"), true);
});

// The hostname check is anchored ($ at the end, requiring a dot or the
// string start immediately before "otodom.pl"), which already defeats both
// classic lookalike-domain tricks below by construction -- these tests make
// that guarantee explicit and regression-proof rather than only implicit in
// the regex.
test("lookalike/spoofed hostnames are rejected, never mistaken for otodom.pl", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://evilotodom.pl/pl/oferta/fake-ID123"), false, "a hostname that merely ends with 'otodom.pl' without a preceding dot must not match");
  assert.equal(isConfirmedOtodomOfferUrl("https://otodom.pl.evil.com/pl/oferta/fake-ID123"), false, "otodom.pl as a subdomain prefix of an unrelated domain must not match");
});

test("a non-https scheme is rejected even with an otherwise valid otodom.pl offer path", () => {
  assert.equal(isConfirmedOtodomOfferUrl("http://www.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS"), false);
});

test("tracking query params never disqualify an otherwise valid offer URL", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS?utm_source=facebook&fbclid=abc123"), true);
});

test("a search-results URL is rejected, never treated as an offer link", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodzkie/lodz/lodz/lodz"), false);
});

test("a category/legacy listing-collection URL is rejected", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/sprzedaz/mieszkanie/lodz/"), false);
});

test("a redirect or any Otodom URL missing an offer identifier is rejected", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/oferta/przykladowe-mieszkanie-bez-id"), false);
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/"), false);
});

test("empty, malformed, or non-Otodom URLs are rejected, never crash", () => {
  assert.equal(isConfirmedOtodomOfferUrl(null), false);
  assert.equal(isConfirmedOtodomOfferUrl(undefined), false);
  assert.equal(isConfirmedOtodomOfferUrl(""), false);
  assert.equal(isConfirmedOtodomOfferUrl("not a url at all"), false);
  assert.equal(isConfirmedOtodomOfferUrl("https://evil.example.com/pl/oferta/fake-ID123"), false);
});

// The exact reported defect: Otodom's own Next.js i18n routing can leak a
// literal, unsubstituted "[lang]" route placeholder into a URL it exposes.
// This must never be treated as a valid offer link.
test("a URL containing a literal, unsubstituted route placeholder like [lang] is rejected", () => {
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/[lang]/oferta/przykladowe-mieszkanie-ID4CRDS"), false);
  assert.equal(isConfirmedOtodomOfferUrl("https://www.otodom.pl/pl/oferta/[slug]-ID4CRDS"), false);
});

test("normalizeOtodomUrl still strips tracking params and the www. prefix (unaffected by this fix)", () => {
  assert.equal(
    normalizeOtodomUrl("https://www.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS?utm_source=x#top"),
    "https://otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS",
  );
});

test("normalizeOtodomUrl gives .html and extensionless offer routes one identity", () => {
  const extensionless = normalizeOtodomUrl("https://www.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS");
  const legacy = normalizeOtodomUrl("https://m.otodom.pl/pl/oferta/przykladowe-mieszkanie-ID4CRDS.html?utm_source=feed#details");
  assert.equal(legacy, extensionless);
});

test("non-offer Otodom paths keep their path instead of being treated as offers", () => {
  assert.equal(
    normalizeOtodomUrl("https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz?utm_source=feed"),
    "https://otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz",
  );
});
