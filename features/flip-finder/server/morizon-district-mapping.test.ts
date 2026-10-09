import assert from "node:assert/strict";
import test from "node:test";
import { SOURCES } from "@/features/flip-finder/server/search-source-registry";
import type { SearchFilter } from "@/features/flip-finder";

const filter: SearchFilter = {
  id: "00000000-0000-4000-8000-000000000002", name: "Morizon diagnostics", sources: ["morizon"], city: "Łódź",
  districts: [], priceMin: null, priceMax: null, areaMin: null, areaMax: null, rooms: [], floorMin: null,
  floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: [], ownershipTypes: [],
  marketType: null, privateOnly: false, maxPricePerSqm: null, requiredKeywords: [], excludedKeywords: [],
  minFlipScore: null, minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60,
  isActive: true, lastScannedAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};

function offer(id: string, addressLocality: string) {
  return {
    "@type": "Product",
    name: `Mieszkanie testowe ${id}`,
    url: `https://www.morizon.pl/oferta/mieszkanie-${id}`,
    price: 450000,
    image: [],
    itemOffered: {
      address: { addressLocality },
      floorSize: { value: 50 },
      numberOfRooms: 2,
      description: "Opis testowy.",
    },
  };
}

function responseFor(offers: Record<string, unknown>[]): Response {
  const html = `<html><script type="application/ld+json">${JSON.stringify(offers)}</script></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

test("Morizon correctly maps every one of the 5 Radar districts to city=Łódź, district=<name> -- not just the two without diacritics", async () => {
  // Live-reproduced bug (2026-10-09): Bałuty/Górna/Śródmieście silently never
  // matched the district allowlist because normalize() strips diacritics
  // (ł/ó/ś -> l/o/s) but the comparison array kept the original spelling, so
  // only Widzew/Polesie (no diacritics) ever matched by coincidence. The
  // unmatched ones left district null and set city to the raw, un-mapped
  // locality (e.g. "Bałuty") instead of "Łódź" -- failing Radar's
  // district_not_confirmed check for 3 of 5 tracked districts.
  const districts = ["Bałuty", "Górna", "Polesie", "Śródmieście", "Widzew"];
  const offers = districts.map((district, index) => offer(String(index), district));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseFor(offers)) as typeof fetch;
  try {
    const source = SOURCES.find((candidate) => candidate.id === "morizon");
    assert.ok(source, "morizon must be a registered source");
    const result = await source!.fetch(filter);
    assert.equal(result.listings.length, 5, `expected all 5 district offers to parse into listings, got warnings: ${result.warnings.join("; ")}`);
    for (const district of districts) {
      const match = result.listings.find((item) => item.district === district);
      assert.ok(match, `${district} must be mapped to district="${district}"`);
      assert.equal(match!.city, "Łódź", `${district}'s listing must have city="Łódź", not the raw locality`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
