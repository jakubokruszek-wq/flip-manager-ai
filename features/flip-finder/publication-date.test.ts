import assert from "node:assert/strict";
import test from "node:test";
import { earliestPublicationDate, formatPublicationLabel, isWithinFinderPublicationWindow, normalizePublicationDate } from "./publication-date.ts";

const now = Date.parse("2026-10-07T12:00:00.000Z");
const day = 86_400_000;

test("publication freshness includes the exact 21-day boundary and excludes older confirmed dates", () => {
  assert.equal(isWithinFinderPublicationWindow(new Date(now - 21 * day).toISOString(), now), true);
  assert.equal(isWithinFinderPublicationWindow(new Date(now - 21 * day - 1).toISOString(), now), false);
  assert.equal(isWithinFinderPublicationWindow(new Date(now - 22 * day).toISOString(), now), false);
});

test("unknown, malformed and future publication dates remain unknown and visible", () => {
  for (const value of [null, "not-a-date", new Date(now + 1).toISOString()]) {
    assert.equal(normalizePublicationDate(value, now), null);
    assert.equal(isWithinFinderPublicationWindow(value, now), true);
    assert.equal(formatPublicationLabel(value, now), "Data publikacji nieznana");
  }
});

test("formatting uses Europe/Warsaw and a reimport cannot rejuvenate an older source date", () => {
  const published = "2026-10-01T10:30:00.000Z";
  assert.match(formatPublicationLabel(published, now), /Opublikowano:/);
  assert.match(formatPublicationLabel(published, now), /12:30/);
  assert.equal(earliestPublicationDate(["2026-10-06T10:00:00.000Z", "2026-09-01T10:00:00.000Z"], now), "2026-09-01T10:00:00.000Z");
});
