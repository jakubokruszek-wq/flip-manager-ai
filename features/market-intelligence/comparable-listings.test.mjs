import assert from "node:assert/strict";
import test from "node:test";

import { compareLocations, selectComparableListings } from "./comparable-listings.ts";
import { preferredListingUrl } from "./comparable-url.ts";

const location = (address, district, city = "Łódź") => ({ address, district, city });

test("dokładnie ta sama ulica", () => {
  assert.deepEqual(compareLocations(location("ul. Piotrkowska", "Śródmieście"), location("Piotrkowska", "Śródmieście")), {
    targetStreet: "piotrkowska", comparableStreet: "piotrkowska", streetMatch: true,
    targetDistrict: "śródmieście", comparableDistrict: "śródmieście", districtMatch: true,
  });
});

test("ta sama dzielnica, inna ulica", () => {
  const result = compareLocations(location("ul. Piotrkowska 10", "Śródmieście"), location("ul. Nawrot 5", "Śródmieście"));
  assert.equal(result.streetMatch, false); assert.equal(result.districtMatch, true);
});

test("to samo miasto, inna dzielnica", () => {
  const result = compareLocations(location("Rojna 2", "Bałuty"), location("Rajdowa 2", "Polesie"));
  assert.equal(result.streetMatch, false); assert.equal(result.districtMatch, false);
});

test("podobne nazwy ulic nie pasują", () => {
  assert.equal(compareLocations(location("Rojna", "Bałuty"), location("Rajdowa", "Bałuty")).streetMatch, false);
});

test("inny numer budynku na tej samej ulicy", () => {
  assert.equal(compareLocations(location("ul. Wielkopolska 41", "Bałuty"), location("Wielkopolska 12A", "Bałuty")).streetMatch, true);
});

test("polskie znaki i Unicode NFC", () => {
  const decomposed = "S\u0301ro\u0301dmies\u0301cie";
  const result = compareLocations(location("ul. Żeromskiego 1", "Śródmieście"), location("Żeromskiego 8", decomposed));
  assert.equal(result.streetMatch, true); assert.equal(result.districtMatch, true);
});

test("dzielnica i miasto w address nie są ulicą", () => {
  const result = compareLocations(location("Bałuty, Łódź", "Bałuty"), location("Bałuty, Łódź", "Bałuty"));
  assert.equal(result.targetStreet, null); assert.equal(result.comparableStreet, null); assert.equal(result.streetMatch, false); assert.equal(result.districtMatch, true);
});

const listing = (id, title) => ({
  id, title, description: null, originalUrl: `https://example.com/${id}`, normalizedUrl: null,
  price: 350000, area: 50, pricePerSqm: 7000, rooms: 2, address: "Bałuty, Łódź",
  district: "Bałuty", city: "Łódź", source: "olx", status: "active",
  lastSeenAt: "2026-08-07T12:00:00.000Z", marketTypes: ["secondary"],
});

const resolved = (neighborhood, street = null) => ({
  street, neighborhood, district: "Bałuty", city: "Łódź", confidence: 0.99,
  evidence: neighborhood, source: "deterministic",
});

test("Radogoszcz Zachód preferuje to samo osiedle przed innymi częściami Bałut", () => {
  const target = listing("target", "Radogoszcz Zachód");
  const same = listing("same", "Radogoszcz Zachód 2");
  const teofilow = listing("teofilow", "Teofilów");
  const zubardz = listing("zubardz", "Żubardź");
  const locations = new Map([
    [target.id, resolved("Radogoszcz Zachód")],
    [same.id, resolved("Radogoszcz Zachód")],
    [teofilow.id, resolved("Teofilów")],
    [zubardz.id, resolved("Żubardź")],
  ]);
  const result = selectComparableListings(target, [teofilow, zubardz, same], locations);
  assert.equal(result[0].id, "same");
  assert.equal(result[0].matchReasons[0], "to samo osiedle");
  assert.ok(result.filter((item) => item.id !== "same").every((item) => item.similarityScore <= 69));
  assert.ok(result.filter((item) => item.id !== "same").every((item) => item.matchReasons[0] === "ta sama dzielnica"));
});

test("link preferuje originalUrl, używa fallbacku i odrzuca fałszywy URL", () => {
  assert.equal(preferredListingUrl("https://original.example/a", "https://normalized.example/a", "olx", "1"), "https://original.example/a");
  assert.equal(preferredListingUrl("ftp://invalid.example/a", "https://normalized.example/a", "olx", "2"), "https://normalized.example/a");
  assert.equal(preferredListingUrl("https://otodom.pl/[lang]/a", null, "otodom", "3"), null);
});
