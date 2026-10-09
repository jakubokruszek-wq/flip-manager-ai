import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import type { SearchFilter } from "../index.ts";
import { EXTERNAL_PORTAL_PARSERS } from "../external-source-adapters.ts";

const FILTER_ID = "77777777-7777-4777-8777-777777777777";
const filter: SearchFilter = {
  id: FILTER_ID,
  name: "Lodz source identity fixture",
  sources: ["gratka", "nieruchomosci_online"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: 30,
  areaMax: 80,
  rooms: [2],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: ["kamienica"],
  ownershipTypes: ["pełna własność"],
  marketType: "secondary",
  privateOnly: false,
  maxPricePerSqm: null,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 30,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

let db = new FakeFacebookSupabase();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => db } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getSearchFilter: async () => filter } });
mock.module("@/features/auth/operator", { namedExports: { requireOperator: async () => ({ id: "operator-a", email: "operator@example.test" }), operatorAuthorizationResponse: () => Response.json({ ok: false }, { status: 401 }) } });
mock.module("@/features/flip-finder/server/listing-ai-analysis", { namedExports: { analyzeListingWithAiIfNeeded: async () => undefined } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined, listResaleComps: async () => [] } });

const { persistListing } = await import("./persist-listing.ts");
const { GET } = await import("../../../app/api/flip-finder/search-filters/[id]/results/route.ts");

function offer(url: string, id: string, streetAddress: string | null, price: number) {
  const itemOffered: Record<string, unknown> = {
    "@type": "Apartment",
    numberOfRooms: 2,
    floorSize: { "@type": "QuantitativeValue", value: "50.2", unitCode: "MTK" },
    marketType: "secondary",
    buildingType: "kamienica",
    description: "Mieszkanie w kamienicy, pełna własność.",
  };
  if (streetAddress) itemOffered.address = { "@type": "PostalAddress", streetAddress, addressLocality: "Łódź" };
  return {
    "@context": "https://schema.org",
    "@type": "Offer",
    name: `Dwupokojowe mieszkanie na sprzedaż · ul. Tuwima · ${streetAddress}`,
    url,
    price,
    priceCurrency: "PLN",
    image: ["https://cdn.example.test/unit/interior-1.jpg?w=320", "https://cdn.example.test/unit/interior-2.jpg?watermark=portal"],
    datePosted: "2026-10-06T12:00:00.000Z",
    itemOffered,
    // The synthetic `id` is intentionally only a portal-local public id.
    identifier: id,
  };
}

function asJsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

test("captured portal JSON -> real parsers -> persistListing -> fake canonical RPC -> Finder GET route groups one exact unit and keeps another apartment separate", async () => {
  db = new FakeFacebookSupabase();
  // The fake persists the query/upsert state and supplies the canonical RPC
  // result; the SQL definition itself is exercised separately by the existing
  // PGlite canonical-reconciliation tests. The API read path below is real.
  installCanonicalReconciliationRpc(db);
  const gratkaHtml = asJsonLd({
    "@context": "https://schema.org",
    "@type": "Product",
    offers: {
      "@type": "AggregateOffer",
      offers: [
        offer("https://gratka.pl/nieruchomosci/mieszkanie-tuwima-12-lodz/ob/gr-12-4", "gr-12-4", "ul. Tuwima 12/4", 365000),
        offer("https://gratka.pl/nieruchomosci/mieszkanie-tuwima-12-lodz/ob/gr-12-5", "gr-12-5", "ul. Tuwima 12/5", 365000),
      ],
    },
  });
  const nieruchomosciHtml = asJsonLd({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    mainEntity: {
      "@type": "Product",
      offers: [{
        "@type": "AggregateOffer",
        offers: [offer("https://lodz.nieruchomosci-online.pl/mieszkanie-tuwima-12-4-o-12345678.html", "nol-12345678", "ul. Tuwima 12/4", 389000)],
      }],
    },
  });

  const gratka = EXTERNAL_PORTAL_PARSERS.gratka(gratkaHtml, "Łódź");
  const nieruchomosci = EXTERNAL_PORTAL_PARSERS.nieruchomosci_online(nieruchomosciHtml, "Łódź");
  assert.deepEqual(gratka.listings.map((row) => row.identityEvidence?.unitKey), ["lodz|tuwima|12|unit:4", "lodz|tuwima|12|unit:5"]);
  assert.equal(nieruchomosci.listings[0]?.identityEvidence?.unitKey, "lodz|tuwima|12|unit:4");

  let scan = 0;
  for (const row of [...gratka.listings, ...nieruchomosci.listings]) {
    await persistListing(db as never, FILTER_ID, row as never, true, [], `scan-${++scan}`, "2026-10-08T10:00:00.000Z", AbortSignal.timeout(1_000), { bucket: "MATCHED", reasons: [], unknownFields: [] });
  }
  assert.equal(db.rows("listings").length, 3, "both portal-local listing records are retained; no canonical source row is deleted");
  assert.equal(db.rows("listing_filter_matches").length, 3, "each canonical source record keeps its own filter membership");

  const response = await GET(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 200);
  const payload = await response.json() as { results: Array<{ id: string; source: string; linkedListings: Array<{ id: string; source: string; originalUrl: string | null }> }>; reviewResults: Array<{ id: string; source: string; linkedListings: Array<{ id: string; source: string; originalUrl: string | null }> }> };
  const visibleCards = [...payload.results, ...payload.reviewResults];
  assert.equal(visibleCards.length, 2, "the Finder API emits one card for unit 12/4 and a separate card for unit 12/5, in either MATCHED or REVIEW");
  const sameUnit = visibleCards.find((row) => row.linkedListings.length === 2);
  const separateUnit = visibleCards.find((row) => row.linkedListings.length === 1);
  assert.ok(sameUnit);
  assert.deepEqual(new Set(sameUnit.linkedListings.map((row) => row.source)), new Set(["gratka", "nieruchomosci_online"]));
  assert.deepEqual(new Set(sameUnit.linkedListings.map((row) => row.originalUrl)), new Set([
    "https://gratka.pl/nieruchomosci/mieszkanie-tuwima-12-lodz/ob/gr-12-4",
    "https://lodz.nieruchomosci-online.pl/mieszkanie-tuwima-12-4-o-12345678.html",
  ]));
  assert.ok(separateUnit);
  assert.equal(separateUnit.source, "gratka");
  assert.equal(db.rows("listings").length, 3, "Finder grouping is a read projection and leaves all canonical rows intact");
});

test("real adapter records auto-group the same agency offer reference, but an equal number at a different agency stays separate", async () => {
  async function cardsFor(agencyNameB: string) {
    db = new FakeFacebookSupabase();
    installCanonicalReconciliationRpc(db);
    const makeAgencyOffer = (url: string, agency: string) => ({
      ...offer(url, url, null, 365000),
      seller: { "@type": "RealEstateAgent", name: agency, additionalProperty: [{ name: "Numer oferty", value: "BIO-71" }] },
    });
    const gratka = EXTERNAL_PORTAL_PARSERS.gratka(asJsonLd({ "@type": "Product", offers: { "@type": "AggregateOffer", offers: [makeAgencyOffer("https://gratka.pl/nieruchomosci/mieszkanie/ob/gr-agency-1", "Biuro Łódź") ] } }), "Łódź");
    const online = EXTERNAL_PORTAL_PARSERS.nieruchomosci_online(asJsonLd({ "@type": "CollectionPage", mainEntity: { "@type": "Product", offers: [{ "@type": "AggregateOffer", offers: [makeAgencyOffer("https://lodz.nieruchomosci-online.pl/mieszkanie-o-12345679.html", agencyNameB)] }] } }), "Łódź");
    assert.ok(gratka.listings[0]?.identityEvidence?.agencyReference);
    assert.ok(online.listings[0]?.identityEvidence?.agencyReference);
    let scan = 0;
    for (const row of [...gratka.listings, ...online.listings]) {
      await persistListing(db as never, FILTER_ID, row as never, true, [], `agency-scan-${++scan}`, "2026-10-08T10:00:00.000Z", AbortSignal.timeout(1_000), { bucket: "MATCHED", reasons: [], unknownFields: [] });
    }
    const response = await GET(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/results`), { params: Promise.resolve({ id: FILTER_ID }) });
    assert.equal(response.status, 200);
    const payload = await response.json() as { results: Array<{ linkedListings: unknown[] }>; reviewResults: Array<{ linkedListings: unknown[] }> };
    return [...payload.results, ...payload.reviewResults];
  }

  const sameAgencyCards = await cardsFor("Biuro Łódź");
  assert.equal(sameAgencyCards.length, 1, "the explicit broker reference, namespaced to one agency by the real parsers, yields one Finder card");
  assert.equal(sameAgencyCards[0]?.linkedListings.length, 2);
  const differentAgencyCards = await cardsFor("Inne Biuro");
  assert.equal(differentAgencyCards.length, 2, "the same text number without the same agency namespace is not a shared offer identity");
  assert.ok(differentAgencyCards.every((card) => card.linkedListings.length === 1));
});
