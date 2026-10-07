import assert from "node:assert/strict";
import test from "node:test";

import { parseExternalSourceJsonLd, type ExternalSourceConfig, type ExternalSourceId } from "./external-source-parser";

const sourceIds: ExternalSourceId[] = [
  "gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo",
  "oferty_net", "szybko", "bezposrednio", "domy", "allegro_lokalnie",
];

function config(id: ExternalSourceId): ExternalSourceConfig {
  return { id, label: id, hostnames: ["portal.example"], searchPath: () => "/lodz" };
}

function fixture(id: ExternalSourceId, url = "https://portal.example/oferta/lodz-123") {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    sku: `${id}-123`,
    url,
    name: "Mieszkanie Łódź Bałuty 2 pokoje",
    description: "Sprzedaż mieszkania, czynsz administracyjny 615 zł.",
    image: ["https://portal.example/img/123.jpg"],
    datePosted: "2026-09-30",
    offers: { price: "489000", priceCurrency: "PLN" },
    itemOffered: {
      "@type": "Apartment",
      floorSize: { value: "53,2", unitCode: "MTK" },
      numberOfRooms: "2",
      address: { addressLocality: "Łódź", addressSuburb: "Bałuty" },
    },
  })}</script>`;
}

test("every configured portal parser produces the canonical sale listing shape", () => {
  for (const id of sourceIds) {
    const listings = parseExternalSourceJsonLd(fixture(id), config(id), "Łódź");
    assert.equal(listings.length, 1, id);
    const listing = listings[0];
    assert.equal(listing.source, id);
    assert.equal(listing.externalListingId, `${id}-123`);
    assert.equal(listing.originalUrl, "https://portal.example/oferta/lodz-123");
    assert.equal(listing.price, 489000);
    assert.equal(listing.area, 53.2);
    assert.equal(listing.rooms, 2);
    assert.equal(listing.city, "Łódź");
    assert.equal(listing.district, "Bałuty");
    assert.deepEqual(listing.images, ["https://portal.example/img/123.jpg"]);
  }
});

test("rental and renovation-program pages never become sale listings", () => {
  const rental = fixture("gratka").replace("Sprzedaż mieszkania, czynsz administracyjny 615 zł.", "Wynajem mieszkania, czynsz 2 500 zł.");
  const program = fixture("gratka").replace("Mieszkanie Łódź Bałuty 2 pokoje", "Mieszkanie za remont Łódź");
  assert.deepEqual(parseExternalSourceJsonLd(rental, config("gratka"), "Łódź"), []);
  assert.deepEqual(parseExternalSourceJsonLd(program, config("gratka"), "Łódź"), []);
});

test("tracking parameters are removed from normalized external URLs", () => {
  const listings = parseExternalSourceJsonLd(fixture("domy", "https://portal.example/oferta/lodz-123?utm_source=feed&fbclid=abc"), config("domy"), "Łódź");
  assert.equal(listings[0]?.normalizedUrl, "https://portal.example/oferta/lodz-123");
});

test("generic unit propertyType does not mask confirmed building and ownership text", () => {
  const html = fixture("domy")
    .replace("Mieszkanie Łódź Bałuty 2 pokoje", "Mieszkanie w bloku Łódź Bałuty 2 pokoje")
    .replace("Sprzedaż mieszkania, czynsz administracyjny 615 zł.", "Pełna własność, czynsz administracyjny 615 zł.")
    .replace('"@type":"Apartment"', '"@type":"Apartment","propertyType":"apartment"');
  const listing = parseExternalSourceJsonLd(html, config("domy"), "Łódź")[0];
  assert.equal(listing?.buildingType, "blok");
  assert.equal(listing?.ownership, "pełna własność");
});

test("European thousands separators are parsed as a sale price, while admin fee text is ignored", () => {
  const html = fixture("domy").replace("489000", "489.000 zł").replace("czynsz administracyjny 615 zł.", "czynsz administracyjny 615 zł.");
  const listing = parseExternalSourceJsonLd(html, config("domy"), "Łódź")[0];
  assert.equal(listing?.price, 489000);
});

test("malformed JSON-LD and foreign host URLs fail closed", () => {
  const html = `<script type="application/ld+json">{bad</script><script type="application/ld+json">${JSON.stringify({ url: "https://other.example/1", offers: { price: 300000 }, floorSize: { value: 40 } })}</script>`;
  assert.deepEqual(parseExternalSourceJsonLd(html, config("gratka"), "Łódź"), []);
});
