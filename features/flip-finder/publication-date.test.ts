import assert from "node:assert/strict";
import test from "node:test";
import {
  earliestPublicationDate,
  formatListingAge,
  formatPublicationLabel,
  latestPublicationDate,
  listingFreshness,
  matchesPublicationAgeFilter,
  normalizePublicationDate,
  parsePublicationAgeFilter,
  publicationAgeDays,
} from "./publication-date.ts";

const now = Date.parse("2026-10-13T12:00:00.000Z");
const day = 86_400_000;

test("publication age is information: listings older than 30 days are flagged, never hidden by this module", () => {
  const old = new Date(now - 137 * day).toISOString();
  const freshness = listingFreshness(old, new Date(now - day).toISOString(), now);
  assert.equal(freshness.ageDays, 137);
  assert.equal(freshness.isOlderListing, true);
  assert.equal(freshness.verificationStale, false);
  assert.equal(listingFreshness(new Date(now - 30 * day).toISOString(), null, now).isOlderListing, false);
  assert.equal(listingFreshness(new Date(now - 31 * day).toISOString(), null, now).isOlderListing, true);
});

test("an offer not confirmed by a scan for more than 3 days is marked as unconfirmed", () => {
  assert.equal(listingFreshness(null, new Date(now - 4 * day).toISOString(), now).verificationStale, true);
  assert.equal(listingFreshness(null, new Date(now - 2 * day).toISOString(), now).verificationStale, false);
  assert.equal(listingFreshness(null, null, now).verificationStale, true);
});

test("the operator age filter keeps unknown dates for bounded windows and selects only confirmed old offers for 'older'", () => {
  const fresh = new Date(now - 5 * day).toISOString();
  const month = new Date(now - 20 * day).toISOString();
  const old = new Date(now - 90 * day).toISOString();
  assert.equal(matchesPublicationAgeFilter(old, "all", now), true);
  assert.equal(matchesPublicationAgeFilter(fresh, "7", now), true);
  assert.equal(matchesPublicationAgeFilter(month, "7", now), false);
  assert.equal(matchesPublicationAgeFilter(month, "30", now), true);
  assert.equal(matchesPublicationAgeFilter(null, "14", now), true);
  assert.equal(matchesPublicationAgeFilter(old, "older", now), true);
  assert.equal(matchesPublicationAgeFilter(null, "older", now), false);
  assert.equal(parsePublicationAgeFilter("nonsense"), "all");
  assert.equal(parsePublicationAgeFilter("older"), "older");
});

test("unknown, malformed and future publication dates remain unknown", () => {
  for (const value of [null, "not-a-date", new Date(now + 1).toISOString()]) {
    assert.equal(normalizePublicationDate(value, now), null);
    assert.equal(publicationAgeDays(value, now), null);
    assert.equal(formatPublicationLabel(value, now), "Data publikacji nieznana");
  }
  assert.equal(formatListingAge(null), "Wiek oferty nieznany");
  assert.equal(formatListingAge(1), "Wiek oferty: 1 dzień");
  assert.equal(formatListingAge(45), "Wiek oferty: 45 dni");
});

test("formatting uses Europe/Warsaw; a reimport cannot rejuvenate the first publication, but the latest refresh is kept for display", () => {
  const published = "2026-10-01T10:30:00.000Z";
  assert.match(formatPublicationLabel(published, now), /Opublikowano:/);
  assert.match(formatPublicationLabel(published, now), /12:30/);
  const values = ["2026-10-06T10:00:00.000Z", "2026-09-01T10:00:00.000Z"];
  assert.equal(earliestPublicationDate(values, now), "2026-09-01T10:00:00.000Z");
  assert.equal(latestPublicationDate(values, now), "2026-10-06T10:00:00.000Z");
});
