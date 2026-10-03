import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fetchExternalPortal, EXTERNAL_PORTAL_PARSERS } from "./external-source-adapters.ts";
import { EXTERNAL_SOURCE_CONFIGS, SOURCES } from "./server/search-source-registry.ts";
import type { ExternalSourceId } from "./external-source-parser.ts";

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });

const SOURCE_IDS: ExternalSourceId[] = ["gratka", "nieruchomosci_online", "domiporta", "sprzedajemy", "adresowo", "oferty_net", "szybko", "bezposrednio", "domy", "allegro_lokalnie"];
const filter = { city: "Łódź" } as never;

function jsonLd(value: unknown, next = false): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>${next ? "<a rel=\"next\" href=\"?page=2\">next</a>" : ""}`;
}

function listingValues(id: string, source: ExternalSourceId, page: number) {
  const slug = `${source}-lodz-${id}`;
  const host = ({ nieruchomosci_online: "nieruchomosci-online.pl", oferty_net: "oferty.net", bezposrednio: "bezposrednio.net.pl", allegro_lokalnie: "allegrolokalnie.pl" } as Record<string, string>)[source] ?? `${source}.pl`;
  return { id: `${id}-${page}`, url: `https://${host}/oferta/${slug}?utm_source=fixture#offer`, title: `Mieszkanie Łódź ${source} ${page}`, description: "Sprzedaż mieszkania, czynsz administracyjny 615 zł.", price: "489 000 zł", area: "53,2", rooms: "2", city: "Łódź", district: "Bałuty", images: [`https://cdn.example/${source}-${page}.jpg`], publishedAt: "2026-09-30" };
}

function fixture(source: ExternalSourceId, page: number): string {
  const item = listingValues("offer", source, page);
  const next = page === 1;
  // Real structure (confirmed against a live, read-only GET of
  // gratka.pl/nieruchomosci/mieszkania/<city>, 2026-10-03): one Product whose
  // `offers` is a single AggregateOffer wrapping every listing as its own
  // Offer in `offers.offers[]` -- never an ItemList, and never price/
  // itemOffered directly on the outer record the way the old fixture assumed.
  // Real per-offer records have no sku/productID/identifier (the fallback
  // URL-derived id exists for exactly this); `item.id` is still threaded
  // through via `sku` here only so this fixture matches the OTHER 9 sources'
  // externalListingId assertions below -- the real-data path is proven
  // separately in "current public result-page structure reaches...".
  if (source === "gratka") return jsonLd({ "@type": "Product", additionalType: "RealEstateListing", name: `Mieszkania na sprzedaż ${item.city}`, url: `https://gratka.pl/nieruchomosci/mieszkania/${item.city.toLowerCase()}`, offers: { "@type": "AggregateOffer", lowPrice: "300000", highPrice: "600000", offers: [{ "@type": "Offer", sku: item.id, url: item.url, name: item.title, price: item.price, image: item.images, datePosted: item.publishedAt, itemOffered: { "@type": "Accommodation", description: item.description, numberOfRooms: item.rooms, floorSize: { value: item.area }, address: { addressLocality: item.district } } }] } }, next);
  if (source === "adresowo") return jsonLd({ "@type": "Residence", identifier: item.id, url: item.url, name: item.title, description: item.description, image: item.images, datePosted: item.publishedAt, offers: { price: item.price }, itemOffered: { floorSize: { value: item.area }, numberOfRooms: item.rooms, address: { addressLocality: item.city, addressSuburb: item.district } } }, next);
  if (source === "domy") return jsonLd({ "@type": "Product", productID: item.id, url: item.url, name: item.title, description: item.description, image: item.images, datePosted: item.publishedAt, offers: { price: item.price }, itemOffered: { floorSize: { value: item.area }, numberOfRooms: item.rooms, address: { addressLocality: item.city, addressSuburb: item.district } } }, next);
  if (source === "szybko") return jsonLd({ "@type": "ItemList", itemListElement: [{ item: { "@type": "Product", sku: item.id, url: item.url, name: item.title, description: item.description, image: item.images, offers: { price: item.price }, itemOffered: { floorSize: { value: item.area }, numberOfRooms: item.rooms, address: { addressLocality: item.city, addressSuburb: item.district } } } }] }, next);
  if (source === "nieruchomosci_online") return `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { ads: [{ id: item.id, href: item.url, title: item.title, description: item.description, price: item.price, area: { value: item.area }, rooms: item.rooms, city: item.city, district: item.district, images: item.images, publishedAt: item.publishedAt }], pagination: { hasNext: next } } } })}</script>`;
  if (source === "bezposrednio") return `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { listings: [{ id: item.id, href: item.url, title: item.title, description: item.description, price: item.price, area: item.area, rooms: item.rooms, city: item.city, district: item.district, images: item.images, publishedAt: item.publishedAt }], pagination: { hasNextPage: next } } } })}</script>`;
  if (source === "allegro_lokalnie") return `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { items: [{ id: item.id, href: item.url, title: item.title, description: item.description, price: { amount: item.price }, size: item.area, rooms: item.rooms, city: item.city, district: item.district, photos: item.images, publishedAt: item.publishedAt }], pagination: { hasNext: next } } } })}</script>`;
  if (source === "sprzedajemy") return `<script>window.__INITIAL_STATE__=${JSON.stringify({ offers: [{ id: item.id, url: item.url, title: item.title, description: item.description, price: item.price, area: item.area, rooms: item.rooms, city: item.city, district: item.district, images: item.images, publishedAt: item.publishedAt }], pagination: { next: next ? "?page=2" : null } })};</script>`;
  const card = `<article data-offer-id="${item.id}" data-url="${item.url}" data-title="${item.title}" data-price="${item.price}" data-area="${item.area}" data-rooms="${item.rooms}" data-city="${item.city}" data-district="${item.district}"><img src="${item.images[0]}"><h2>${item.title}</h2></article>`;
  return `${card}${next ? "<a data-next-page=\"true\">next</a>" : ""}`;
}

function config(source: ExternalSourceId) { return EXTERNAL_SOURCE_CONFIGS.find((item) => item.id === source)!; }

test("each portal parser maps its own fixture to a canonical SourceListing", () => {
  for (const source of SOURCE_IDS) {
    const result = EXTERNAL_PORTAL_PARSERS[source](fixture(source, 1), "Łódź");
    assert.equal(result.listings.length, 1, source);
    assert.equal(result.listings[0]?.source, source);
    assert.equal(result.listings[0]?.externalListingId, "offer-1", source);
    assert.equal(result.listings[0]?.normalizedUrl.includes("utm_"), false, source);
    assert.equal(result.listings[0]?.price, 489000, source);
    assert.equal(result.listings[0]?.area, 53.2, source);
    assert.equal(result.listings[0]?.rooms, 2, source);
    assert.equal(result.listings[0]?.city, "Łódź", source);
  }
});

test("every portal adapter paginates, keeps IDs stable, and deduplicates a repeated page", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const source of SOURCE_IDS) {
      const requested: string[] = [];
      globalThis.fetch = async (input) => { const url = String(input); requested.push(url); const page = new URL(url).searchParams.get("page") === "2" ? 2 : 1; return new Response(fixture(source, page), { status: 200, headers: { "content-type": "text/html" } }); };
      const result = await fetchExternalPortal(config(source), filter, undefined);
      assert.equal(requested.length, 2, source);
      assert.equal(result.listings.length, 2, source);
      assert.deepEqual(result.listings.map((listing) => listing.externalListingId), ["offer-1", "offer-2"], source);

      const duplicatePage = fixture(source, 1).replaceAll("offer-1", "offer-1");
      const parsed = EXTERNAL_PORTAL_PARSERS[source](duplicatePage + duplicatePage, "Łódź");
      assert.equal(parsed.listings.length, 1, `${source} duplicate id`);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("malformed portal pages fail closed and HTTP errors never become listings", async () => {
  for (const source of SOURCE_IDS) {
    assert.deepEqual(EXTERNAL_PORTAL_PARSERS[source]("<html>blocked</html>", "Łódź").listings, [], source);
  }
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("blocked", { status: 403 }); };
  try {
    await assert.rejects(fetchExternalPortal(config("szybko"), filter), /Szybko\.pl: HTTP 403\./);
    assert.equal(calls, 1, "HTTP 403 must fail closed without proxy/rotation/retry");
  } finally { globalThis.fetch = previousFetch; }
});

test("each adapter output is idempotent through the existing canonical persistListing path", async () => {
  const { persistListing } = await import("./server/persist-listing.ts");
  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  for (const source of SOURCE_IDS) {
    const listing = EXTERNAL_PORTAL_PARSERS[source](fixture(source, 1), "Łódź").listings[0]!;
    const first = await persistListing(db as never, "filter-1", listing, true, [], "scan-1", "2026-10-02T10:00:00Z", AbortSignal.timeout(1000));
    const second = await persistListing(db as never, "filter-1", listing, true, [], "scan-1", "2026-10-02T10:01:00Z", AbortSignal.timeout(1000));
    assert.equal(first.listingId, second.listingId, source);
  }
  assert.equal(rows.length, SOURCE_IDS.length);
  assert.deepEqual(rows.map((row) => row.source), SOURCE_IDS);
});

function fakeDb(rows: Record<string, unknown>[]) {
  let sequence = 0;
  return { from(table: string) { const filters: Record<string, unknown> = {}; let operation = "select"; let payload: Record<string, unknown> | null = null; const builder: Record<string, unknown> = { select: () => builder, eq: (key: string, value: unknown) => { filters[key] = value; return builder; }, order: () => builder, limit: () => builder, abortSignal: () => builder, insert: (value: Record<string, unknown>) => { operation = "insert"; payload = value; return builder; }, upsert: (value: Record<string, unknown>) => { operation = "upsert"; payload = value; return builder; }, maybeSingle: async () => ({ data: rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }), single: async () => { if (table === "listings" && operation === "upsert" && payload) { const existing = rows.find((row) => row.source === payload?.source && row.external_listing_id === payload?.external_listing_id); if (existing) Object.assign(existing, payload); else rows.push({ ...payload, id: `listing-${++sequence}` }); return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null }; } return { data: { id: `row-${++sequence}` }, error: null }; }, then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve, reject) }; return builder; } };
}

// Real public page excerpt (read-only GET of gratka.pl/nieruchomosci/mieszkania/lodz,
// 2026-10-03), trimmed to 3 of the page's real 35 offers -- including one
// genuinely missing a `price` (2 of the real 35 had none, presumably
// price-on-request/multi-unit listings), which must be filtered out rather
// than crash or coerce to a fake price. Proves the real, nested
// AggregateOffer.offers[] shape reaches persistListing end to end, not just
// a hand-built fixture shaped to match the parser's own assumptions.
const GRATKA_REAL_PAGE_1 = JSON.stringify({
  "@context": "https://schema.org", "@type": "Product", additionalType: "RealEstateListing",
  name: "Mieszkania na sprzedaż Łódź", url: "https://gratka.pl/nieruchomosci/mieszkania/lodz",
  offers: {
    "@type": "AggregateOffer", lowPrice: "189000.00", highPrice: "1269560.00", businessFunction: "https://purl.org/goodrelations/v1#Sell",
    offers: [
      { "@context": "https://schema.org", "@type": "Offer", availability: "https://schema.org/InStock", image: "https://img1.staticmorizon.com.pl/thumb/offer1.jpg", name: "Mieszkanie na sprzedaż, 45 m² Teofilów, Łanowa", price: "419000.00", priceCurrency: "PLN", url: "https://gratka.pl/nieruchomosci/mieszkanie-lodz-baluty-lanowa/oi/49128417", itemOffered: { "@type": "Accommodation", address: { "@type": "PostalAddress", addressCountry: "Polska", streetAddress: "Łanowa", addressLocality: "Teofilów" }, description: "2 POKOJE PO GENERALNYM REMONCIE | 45 m² | PARTER | TEOFILÓW okolice ul. Łanowej, Łódź Cena: 419 000 zł Czynsz: 515 zł", numberOfRooms: 2, floorSize: { "@type": "QuantitativeValue", value: "45.00", unitCode: "MTK" } } },
      { "@context": "https://schema.org", "@type": "Offer", availability: "https://schema.org/InStock", image: "https://img1.staticmorizon.com.pl/thumb/offer2.jpg", name: "Mieszkanie na sprzedaż, 50 m² Dąbrowa, Poli Gojawiczyńskiej", price: "499000.00", priceCurrency: "PLN", url: "https://gratka.pl/nieruchomosci/mieszkanie-lodz-gorna-poli-gojawiczynskiej/ob/49172279", itemOffered: { "@type": "Accommodation", address: { "@type": "PostalAddress", addressCountry: "Polska", streetAddress: "Poli Gojawiczyńskiej", addressLocality: "Dąbrowa" }, description: "Na sprzedaż funkcjonalne 3-pokojowe mieszkanie po generalnym remoncie, Dąbrowa.", numberOfRooms: 3, floorLevel: 4, floorSize: { "@type": "QuantitativeValue", value: "50.06", unitCode: "MTK" } } },
      { "@context": "https://schema.org", "@type": "Offer", availability: "https://schema.org/InStock", image: "https://img1.staticmorizon.com.pl/thumb/offer3.jpg", name: "Mieszkanie na sprzedaż, 34 m² Polesie, Pogonowskiego 44/46", url: "https://gratka.pl/nieruchomosci/mieszkanie-lodz-polesie-pogonowskiego-44-46/ob/42440307", itemOffered: { "@type": "Accommodation", address: { "@type": "PostalAddress", addressCountry: "Polska", streetAddress: "Pogonowskiego 44/46", addressLocality: "Polesie" }, description: "Atrium przy ul. Pogonowskiego -- inwestycja wielu możliwości, cena na zapytanie.", numberOfRooms: 2, floorLevel: 3, floorSize: { "@type": "QuantitativeValue", value: "33.94", unitCode: "MTK" } } },
    ],
  },
});

test("the real gratka.pl public page structure (AggregateOffer.offers[], captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const html = `<script type="application/ld+json">${GRATKA_REAL_PAGE_1}</script><link href="https://gratka.pl/nieruchomosci/mieszkania/lodz?page=2" rel="next">`;
  const parsed = EXTERNAL_PORTAL_PARSERS.gratka(html, "Łódź");
  assert.equal(parsed.listings.length, 2, "the price-less third offer must be filtered out, never kept with a fake/zero price");
  assert.equal(parsed.hasNextPage, true, "the real rel=\"next\" link must be detected");
  const [first, second] = parsed.listings;
  assert.equal(first?.price, 419000);
  assert.equal(first?.area, 45);
  assert.equal(first?.rooms, 2);
  assert.equal(first?.city, "Łódź", "city must come from the search city, never Gratka's own addressLocality (which is actually the district)");
  assert.equal(first?.district, "Teofilów");
  assert.equal(first?.externalListingId, "49128417", "the numeric id must be recovered from the URL since real offers carry no sku/productID/identifier");
  assert.equal(second?.price, 499000);
  assert.equal(second?.district, "Dąbrowa");

  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const isPage2 = String(input).includes("page=2");
      return new Response(isPage2 ? `<script type="application/ld+json">${GRATKA_REAL_PAGE_1.replace(/49128417|49172279|42440307/g, (id) => `9${id}`)}</script>` : html, { status: 200, headers: { "content-type": "text/html" } });
    };
    const fetched = await fetchExternalPortal(config("gratka"), filter, undefined);
    assert.equal(fetched.listings.length, 4, "2 real listings per page across the 2 fetched pages, distinct ids");
  } finally { globalThis.fetch = previousFetch; }

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", first!, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 419000);
});

test("the registry exposes every new adapter for the schema gate", () => {
  assert.deepEqual(SOURCES.filter((source) => SOURCE_IDS.includes(source.id as ExternalSourceId)).map((source) => source.id), SOURCE_IDS);
});
