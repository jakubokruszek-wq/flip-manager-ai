import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { fetchExternalPortal, EXTERNAL_PORTAL_PARSERS, parseRadarOfferDetail } from "./external-source-adapters.ts";
import { activeSources, EXTERNAL_SOURCE_CONFIGS, SOURCES } from "./server/search-source-registry.ts";
import type { ExternalSourceId } from "./external-source-parser.ts";
import { qualifyRadarCandidate } from "@/features/price-radar/qualification";

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
  // Real structure (confirmed against a live, read-only GET of
  // oferty.net/mieszkania,<city>, 2026-10-03): a plain server-rendered
  // <table> of rows (tr.property), not JSON-LD/__NEXT_DATA__/Microdata --
  // the id is recovered from the trailing ",<id>" segment of the detail URL
  // (the real site has no separate id attribute anywhere), and pagination
  // is a numbered paginator with no rel="next" marker.
  if (source === "oferty_net") {
    const url = item.url.replace("?", `,${item.id}?`);
    const paginator = next
      ? `<div class="paginator"><li class="navigate current"><div><a>1</a></div></li><li class="navigate"><div><a href="?page=2">2</a></div></li></div>`
      : `<div class="paginator"><li class="navigate current"><div><a>2</a></div></li></div>`;
    return `<table><tr class="property"><td class="cell_photo"><img alt="${item.title}" data-original="${item.images[0]}"></td><td class="cell_location"><a href="${url}" title="mieszkanie na sprzedaż ${item.city}, ${item.district}">${item.title}</a></td><td class="cell_area">${item.area}m²</td><td class="cell_rooms">${item.rooms}</td><td class="cell_price">${item.price}</td><td class="cell_added_at">${item.publishedAt}</td></tr></table>${paginator}`;
  }
  if (source === "adresowo") return jsonLd({ "@type": "Residence", identifier: item.id, url: item.url, name: item.title, description: item.description, image: item.images, datePosted: item.publishedAt, offers: { price: item.price }, itemOffered: { floorSize: { value: item.area }, numberOfRooms: item.rooms, address: { addressLocality: item.city, addressSuburb: item.district } } }, next);
  // Real structure (confirmed against a live, read-only GET of
  // domy.pl/mieszkania--<city>-pl, 2026-10-03): the page has no JSON-LD or
  // __NEXT_DATA__ at all -- listings are server-rendered
  // <article class="propertyBox"> cards, and the room count is a Polish
  // word in the title attribute ("Dwupokojowe" = 2), never a number.
  if (source === "domy") {
    const url = `https://domy.pl/mieszkanie/${item.id}`;
    return `<article class="propertyBox"><a class="property_link" href="${url}" title="Dwupokojowe mieszkanie na sprzedaż ${item.city}, ${item.district}">${item.city}, ${item.district}</a><span class="price">${item.price}</span><span class="area">${item.area}m²</span></article>${next ? "<a rel=\"next\" href=\"?page=2\">next</a>" : ""}`;
  }
  // Real structure (confirmed against a live, read-only GET of szybko.pl's
  // own search-form result, 2026-10-03): the page has no JSON-LD or
  // __NEXT_DATA__ at all -- listings are schema.org Microdata rendered
  // directly in the HTML (itemscope/itemprop attributes on real elements),
  // keyed by a `data-assetid` attribute on each card.
  if (source === "szybko") return `<div data-assetid="${item.id}"><a class="listing-title-heading" href="${item.url}">${item.title}</a><span itemprop="name">${item.title}</span><span itemprop="description">${item.description}</span><span itemprop="price" content="${item.price}"></span><link itemprop="image" href="${item.images[0]}"><li class="asset-feature area">${item.area}m2</li><li class="asset-feature rooms">${item.rooms}</li><a class="popup-gmaps">${item.city} (${item.district})</a></div>${next ? "<a rel=\"next\" href=\"?page=2\">next</a>" : ""}`;
  // Real structure (confirmed against a live, read-only GET of
  // lodz.nieruchomosci-online.pl/mieszkania,sprzedaz/, 2026-10-03): a
  // CollectionPage whose mainEntity (a Product) carries every listing as a
  // nested Offer inside mainEntity.offers[0].offers[] -- there is no
  // __NEXT_DATA__ on this site at all.
  if (source === "nieruchomosci_online") return jsonLd({ "@type": "CollectionPage", mainEntity: { "@type": "Product", offers: [{ "@type": "AggregateOffer", offers: [{ "@type": "Offer", sku: item.id, url: item.url, name: item.title, price: item.price, image: item.images, datePosted: item.publishedAt, itemOffered: { "@type": "Accommodation", description: item.description, numberOfRooms: item.rooms, floorSize: { value: item.area }, address: { addressLocality: item.city } } }] }] } }, next);
  if (source === "bezposrednio") return `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { listings: [{ id: item.id, href: item.url, title: item.title, description: item.description, price: item.price, area: item.area, rooms: item.rooms, city: item.city, district: item.district, images: item.images, publishedAt: item.publishedAt }], pagination: { hasNextPage: next } } } })}</script>`;
  // Real structure (confirmed against a live, read-only GET of
  // allegrolokalnie.pl/oferty/nieruchomosci/mieszkania-na-sprzedaz-112739/<city>,
  // 2026-10-03): the page has no __NEXT_DATA__ at all -- real data is a flat
  // schema.org ItemList in JSON-LD, with no separate area/rooms/address
  // fields on each item, only a free-text name to parse them from. The id is
  // recovered from the url's last path segment (the real site has no
  // sku/productID anywhere); pagination is a numbered page-count control,
  // not a rel="next" link.
  if (source === "allegro_lokalnie") {
    const url = `https://allegrolokalnie.pl/oferta/${item.id}`;
    const itemListElement = [{ "@type": "ListItem", item: { "@type": "Product", name: `Mieszkanie, ${item.city}, ${item.district}, ${item.area}m²`, url, offers: { "@type": "Offer", price: item.price }, image: { url: item.images[0] } } }];
    const pagination = `<input class="ml-pagination__input" value="${next ? 1 : 2}"><span class="ml-pagination__count">z 2</span>`;
    return `${jsonLd({ "@type": "ItemList", itemListElement })}${pagination}`;
  }
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
    // Allegro Lokalnie's real listing records carry no room count anywhere
    // (confirmed against a live page, 2026-10-03) -- only a free-text name
    // with city/district/area, never rooms. Every other source's real page
    // does expose a room count, so only this one is exempted here rather
    // than weakening the assertion for all ten.
    if (source !== "allegro_lokalnie") assert.equal(result.listings[0]?.rooms, 2, source);
    assert.equal(result.listings[0]?.city, "Łódź", source);
  }
});

test("the real external-source dispatch skips a missing/zero sale price, warns, and still returns valid offers", async () => {
  const originalFetch = globalThis.fetch;
  const invalid = listingValues("invalid", "gratka", 1);
  invalid.price = "0 zł";
  const valid = listingValues("valid", "gratka", 1);
  const html = jsonLd({
    "@type": "Product",
    additionalType: "RealEstateListing",
    name: "Mieszkania na sprzedaż Łódź",
    url: "https://gratka.pl/nieruchomosci/mieszkania/lodz",
    offers: {
      "@type": "AggregateOffer",
      offers: [invalid, valid].map((item) => ({
        "@type": "Offer", sku: item.id, url: item.url, name: item.title, price: item.price, datePosted: item.publishedAt,
        itemOffered: { "@type": "Accommodation", description: item.description, numberOfRooms: item.rooms, floorSize: { value: item.area }, address: { addressLocality: item.city } },
      })),
    },
  });
  globalThis.fetch = async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  try {
    const result = await fetchExternalPortal(config("gratka"), filter);
    assert.equal(result.fetched, 2, "the raw candidate count includes the rejected row for diagnostics");
    assert.equal(result.listings.length, 1);
    assert.equal(result.listings[0]?.externalListingId, "valid-1");
    assert.ok(result.warnings.some((warning) => warning.startsWith("INVALID_SALE_PRICE:")));
  } finally {
    globalThis.fetch = originalFetch;
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

test("current public result-page structures reach persistListing and the Finder gate", async () => {
  const publicFixtures: Record<ExternalSourceId, string> = {
    domiporta: jsonLd({ "@graph": [{ "@type": "ItemList", itemListElement: [{ "@type": "ListItem", item: { "@type": ["Product", "RealEstateListing"], name: "Mieszkanie 3 pokoje 49 m² Łódź", description: "Oferta sprzedaży mieszkania.", image: "https://galeria.domiporta.pl/offer.jpg", datePosted: "2026-10-01", offers: { "@type": "Offer", price: 439000, priceCurrency: "PLN", itemOffered: { "@type": "Accommodation", numberOfRooms: 3, floorSize: { value: 49 }, address: { addressLocality: "Łódź", addressRegion: "łódzkie" } } }, url: "https://www.domiporta.pl/nieruchomosci/sprzedam-mieszkanie-lodz-49m2/156937475" } }] }] }),
    sprzedajemy: jsonLd({ "@type": "ItemList", itemListElement: [{ "@type": ["ListItem", "Offer"], name: "Mieszkanie 2 pokoje 46 m² Łódź", image: "https://thumbs.img-sprzedajemy.pl/offer.jpg", url: "https://sprzedajemy.pl/mieszkanie-2-pokoje-lodz-nr73909448", position: 1, price: 439000, priceCurrency: "PLN" }] }),
    adresowo: `<div data-offer-card data-id="4224120"><a href="/o/mieszkanie-lodz-polesie-2-pokojowe-m3s4f8"><img src="https://s2.adresowo.pl/offer.webp" alt="Mieszkanie 2-pokojowe Łódź Polesie"></a><h2>Mieszkanie 2-pokojowe Łódź Polesie</h2><span class="font-bold">439 000</span><span> zł</span><span class="font-bold">46</span><span> m²</span><span class="font-bold">2</span><span> pok.</span></div>`,
  } as Record<ExternalSourceId, string>;
  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const previousFetch = globalThis.fetch;
  try {
    for (const source of ["domiporta", "sprzedajemy", "adresowo"] as const) {
      const parsed = EXTERNAL_PORTAL_PARSERS[source](publicFixtures[source], "Łódź");
      assert.equal(parsed.listings.length, 1, `${source} parser`);
      const listing = parsed.listings[0]!;
      assert.equal(listing.price, 439000, `${source} price`);
      assert.equal(listing.area, source === "domiporta" ? 49 : 46, `${source} area`);
      globalThis.fetch = async () => new Response(publicFixtures[source], { status: 200, headers: { "content-type": "text/html" } });
      const fetched = await fetchExternalPortal(config(source), filter, undefined);
      assert.equal(fetched.listings.length, 1, `${source} fetch`);
      const persisted = await import("./server/persist-listing.ts").then(({ persistListing }) => persistListing(db as never, "filter-1", listing, true, [], "scan-1", "2026-10-02T10:00:00Z", AbortSignal.timeout(1000)));
      assert.ok(persisted.listingId, `${source} canonical listing`);
    }
    assert.deepEqual(activeSources({ city: "Łódź", sources: ["domiporta", "sprzedajemy", "adresowo"] } as never).map((source) => source.id), ["domiporta", "sprzedajemy", "adresowo"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function fakeDb(rows: Record<string, unknown>[]) {
  let sequence = 0;
  return { from(table: string) { const filters: Record<string, unknown> = {}; let operation = "select"; let payload: Record<string, unknown> | null = null; const builder: Record<string, unknown> = { select: () => builder, eq: (key: string, value: unknown) => { filters[key] = value; return builder; }, filter: (key: string, operator: string, value: unknown) => { if (operator === "eq") filters[key] = value; return builder; }, order: () => builder, limit: () => builder, abortSignal: () => builder, insert: (value: Record<string, unknown>) => { operation = "insert"; payload = value; return builder; }, upsert: (value: Record<string, unknown>) => { operation = "upsert"; payload = value; return builder; }, update: (value: Record<string, unknown>) => { operation = "update"; payload = value; return builder; }, maybeSingle: async () => ({ data: table === "listings" ? rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null : null, error: null }), single: async () => { if (table === "listings" && operation === "upsert" && payload) { const existing = rows.find((row) => row.source === payload?.source && row.external_listing_id === payload?.external_listing_id); if (existing) Object.assign(existing, payload); else rows.push({ ...payload, id: `listing-${++sequence}` }); return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null }; } return { data: { id: `row-${++sequence}` }, error: null }; }, then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => { if (table === "listings" && operation === "update" && payload) { for (const row of rows) if (Object.entries(filters).every(([key, value]) => row[key] === value)) Object.assign(row, payload); } return Promise.resolve({ data: [], error: null }).then(resolve, reject); } }; return builder; } };
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

// Real public page excerpt (read-only GET of lodz.nieruchomosci-online.pl/
// mieszkania,sprzedaz/, 2026-10-03), trimmed to 2 of the page's real 47
// offers. Unlike Gratka, addressLocality here genuinely IS the city
// ("Łódź"), and real offers carry no sku/productID/identifier either --
// recovered from the URL the same way.
const NOL_REAL_PAGE_1 = JSON.stringify({
  "@context": "https://schema.org", "@type": "CollectionPage",
  name: "Mieszkania na sprzedaż Łódź - Oferty „sprzedam mieszkanie”",
  url: "https://lodz.nieruchomosci-online.pl/mieszkania,sprzedaz/",
  mainEntity: {
    "@type": "Product", additionalType: ["RealEstateListing", "Accommodation"],
    url: "https://lodz.nieruchomosci-online.pl/mieszkania,sprzedaz/",
    offers: [{
      "@type": "AggregateOffer", highPrice: "1600000", lowPrice: "120000", offerCount: "47", priceCurrency: "PLN",
      offers: [
        { "@type": "Offer", availability: "InStock", price: "305000", priceCurrency: "PLN", url: "https://lodz.nieruchomosci-online.pl/mieszkanie-w-bloku-mieszkalnym,wysoki-standard/27005435.html", image: "https://i.st-nieruchomosci-online.pl/k2kq72l/mieszkanie-lodz.jpg", itemOffered: { "@type": "Accommodation", description: "Sprzedam mieszkanie spółdzielcze własnościowe z księgą wieczystą o powierzchni 28,32 m.", address: { "@type": "PostalAddress", streetAddress: "Rojna", addressLocality: "Łódź", addressCountry: "Polska", addressRegion: "łódzkie" }, floorSize: { "@type": "QuantitativeValue", value: "28.32", unitCode: "MTR" }, numberOfRooms: 1 }, name: "Sprzedam Mieszkanie Łódź - 28,32 m²" },
        { "@type": "Offer", availability: "InStock", price: "", priceCurrency: "PLN", url: "https://lodz.nieruchomosci-online.pl/nowe-mieszkanie,boska-pabianicka/26818769.html", image: "https://i.st-nieruchomosci-online.pl/kp9z8bl/boska-pabianicka.jpg", itemOffered: { "@type": "Accommodation", description: "3-pokojowe mieszkanie o powierzchni 51 m.", address: { "@type": "PostalAddress", streetAddress: "Boska", addressLocality: "Łódź", addressCountry: "Polska" }, floorSize: { "@type": "QuantitativeValue", value: "51", unitCode: "MTK" }, numberOfRooms: 3 }, name: "Sprzedam Mieszkanie Łódź - 51 m²" },
      ],
    }],
  },
});

test("the real nieruchomosci-online.pl public page structure (CollectionPage -> mainEntity -> offers[0].offers[], captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const html = `<script type="application/ld+json">${NOL_REAL_PAGE_1}</script>`;
  const parsed = EXTERNAL_PORTAL_PARSERS.nieruchomosci_online(html, "Łódź");
  assert.equal(parsed.listings.length, 1, "the price-less second offer must be filtered out, never kept with a fake/zero price");
  const [first] = parsed.listings;
  assert.equal(first?.price, 305000);
  assert.equal(first?.area, 28.32);
  assert.equal(first?.rooms, 1);
  assert.equal(first?.city, "Łódź", "addressLocality genuinely is the city on this site, unlike Gratka's district quirk");
  assert.equal(first?.externalListingId, "27005435.html", "the id must be recovered from the URL since real offers carry no sku/productID/identifier");

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", first!, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 305000);
});

// Real public page excerpt (read-only GET against szybko.pl's own search
// form result for Łódź, 2026-10-03), trimmed to 2 of the page's real 465
// offers. The site renders schema.org Microdata directly in the HTML
// (itemscope/itemprop attributes), not JSON-LD or __NEXT_DATA__ -- every
// field here (price, area, rooms, address) is read from real markup, not a
// hand-built shape chosen to match the parser's own assumptions.
const SZYBKO_REAL_PAGE_1 = `
<div id="asset-24241927" data-assetid="15702954" class="listing-item" itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem">
  <a href="/o/na-sprzedaz/lokal-mieszkalny/%C5%81%C3%B3d%C5%BA+Widzew/oferta-15702954" class="listing-img-container">Mieszkanie 4 pokojowe</a>
  <div class="listing-content" itemprop="item" itemscope itemtype="https://schema.org/Product">
    <link itemprop="image" href="https://mediaproxy.szybko.pl/600x375/photo/asset/015/702/954/3820c369a0cc78d2262135177d532934.jpg" />
    <span itemprop="name">Mieszkanie 4 pokojowe</span>
    <span itemprop="description">4 pokojowe mieszkanie na rozchwytywanym Janowie - Olechowie! Opiekun oferty: Katarzyna Czyżewska.</span>
    <div class="listing-title" itemprop="offers" itemscope itemtype="https://schema.org/Offer">
      <h4><a href="/o/na-sprzedaz/lokal-mieszkalny/%C5%81%C3%B3d%C5%BA+Widzew/oferta-15702954" itemprop="url" class="listing-title-heading hide-overflow-text">Mieszkanie 4 pokojowe</a></h4>
      <div class="listing-address hide-overflow-text">
        <span class="listing-title-address">Lokal Mieszkalny na sprzedaż -</span>
        <a href="https://www.openstreetmap.org/export/embed.html" class="mapClassClick list-elem-address popup-gmaps" data-assetid="15702954">Łódź (Widzew) (Łódzkie, gm. Łódź)</a>
      </div>
      <span itemprop="price" content="799999"></span>
      <span itemprop="priceCurrency" content="PLN"></span>
    </div>
    <ul class="listing-features">
      <li class="asset-feature area">72m<sup>2</sup> <i class="fa fa-arrows-alt"></i></li>
      <li class="asset-feature rooms">4 <i class="fa fa-bed"></i></li>
    </ul>
  </div>
</div>
<div id="asset-24690712" data-assetid="15725983" class="listing-item" itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem">
  <a href="/o/na-sprzedaz/lokal-mieszkalny/%C5%81%C3%B3d%C5%BA+Polesie/oferta-15725983" class="listing-img-container">Mieszkanie 2 pokojowe</a>
  <div class="listing-content" itemprop="item" itemscope itemtype="https://schema.org/Product">
    <link itemprop="image" href="https://mediaproxy.szybko.pl/600x375/photo/asset/015/725/983/e4a88e0bd0aa796520bac3817ae91e68.jpg" />
    <span itemprop="name">Mieszkanie 2 pokojowe</span>
    <span itemprop="description">Przestronne 2 pokoje na Retkini w zielonej okolicy! Opiekun oferty: Katarzyna Czyżewska.</span>
    <div class="listing-title" itemprop="offers" itemscope itemtype="https://schema.org/Offer">
      <h4><a href="/o/na-sprzedaz/lokal-mieszkalny/%C5%81%C3%B3d%C5%BA+Polesie/oferta-15725983" itemprop="url" class="listing-title-heading hide-overflow-text">Mieszkanie 2 pokojowe</a></h4>
      <div class="listing-address hide-overflow-text">
        <span class="listing-title-address">Lokal Mieszkalny na sprzedaż -</span>
        <a href="https://www.openstreetmap.org/export/embed.html" class="mapClassClick list-elem-address popup-gmaps" data-assetid="15725983">Łódź (Polesie) (Łódzkie, gm. Łódź)</a>
      </div>
      <span itemprop="price" content="278000"></span>
      <span itemprop="priceCurrency" content="PLN"></span>
    </div>
    <ul class="listing-features">
      <li class="asset-feature area">30m<sup>2</sup> <i class="fa fa-arrows-alt"></i></li>
      <li class="asset-feature rooms">2 <i class="fa fa-bed"></i></li>
    </ul>
  </div>
</div>
<a rel="next" href="?page=2">next</a>`;

test("the real szybko.pl public page structure (schema.org Microdata, captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const parsed = EXTERNAL_PORTAL_PARSERS.szybko(SZYBKO_REAL_PAGE_1, "Łódź");
  assert.equal(parsed.listings.length, 2);
  assert.equal(parsed.hasNextPage, true, "the real rel=\"next\" link must be detected");
  const [first, second] = parsed.listings;
  assert.equal(first?.price, 799999);
  assert.equal(first?.area, 72);
  assert.equal(first?.rooms, 4);
  assert.equal(first?.city, "Łódź", "city must be recovered from the address link text, not left to the search-city fallback");
  assert.equal(first?.district, "Widzew");
  assert.equal(first?.externalListingId, "15702954", "the id must come from data-assetid, matching the detail URL's own oferta-<id> slug");
  assert.equal(second?.price, 278000);
  assert.equal(second?.district, "Polesie");

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", first!, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 799999);
});

// Real public page excerpt (read-only GET of oferty.net/mieszkania,lodz,
// 2026-10-03), trimmed to 3 of the page's real ~20 rows -- including one
// genuine rental row ("na wynajem"/"do wynajęcia"), which must be filtered
// out by the existing RENTAL_SIGNAL check rather than kept as a sale
// listing. Proves the real <table class="property"> row shape reaches
// persistListing end to end, not a hand-built shape chosen to match the
// parser's own assumptions.
const OFERTY_NET_REAL_PAGE_1 = `<table>
<tr class="property highlight oddRow" onclick="window.location = 'https://www.oferty.net/mieszkanie-na-sprzedaz-kadlubka-lodz-gorna-41m2-2-pokoje-425000-pln-ba,1543094322'; return false;">
<td class="cell_photo"><img alt="Mieszkanie na sprzedaż - Kadłubka Dąbrowa, Górna, Łódź, 41 m², 425 000 PLN, NET-10.2" data-original="https://img1.staticoferty.net.pl/thumbnail/offer1.jpg" /></td>
<td class="cell_location"><a title="mieszkanie na sprzedaż Łódź, Dąbrowa" href="https://www.oferty.net/mieszkanie-na-sprzedaz-kadlubka-lodz-gorna-41m2-2-pokoje-425000-pln-ba,1543094322">mieszkanie&nbsp;na&nbsp;sprzedaż<br/>Łódź, Dąbrowa</a></td>
<td class="cell_area">41 m²</td>
<td class="cell_rooms">2</td>
<td class="cell_price">425 000</td>
<td class="cell_price_m2">10 365,85</td>
<td class="cell_added_at">23:42<br/>2026-10-02</td>
</tr>
<tr class="property highlight" onclick="window.location = 'https://www.oferty.net/mieszkanie-na-sprzedaz-retkinska-lodz-polesie-52m2-3-pokoje-409000-pln-ba,1543066497'; return false;">
<td class="cell_photo"><img alt="Mieszkanie na sprzedaż - Retkińska Retkinia, Łódź-Polesie, Łódź, 52,78 m², 409 000 PLN, NET-935384" data-original="https://img3.staticoferty.net.pl/thumbnail/offer2.jpg" /></td>
<td class="cell_location"><a title="mieszkanie na sprzedaż Łódź, Retkinia" href="https://www.oferty.net/mieszkanie-na-sprzedaz-retkinska-lodz-polesie-52m2-3-pokoje-409000-pln-ba,1543066497">mieszkanie&nbsp;na&nbsp;sprzedaż<br/>Łódź, Retkinia</a></td>
<td class="cell_area">52,78 m²</td>
<td class="cell_rooms">3</td>
<td class="cell_price">409 000</td>
<td class="cell_price_m2">7749,15</td>
<td class="cell_added_at">19:54<br/>2026-09-29</td>
</tr>
<tr class="property highlight oddRow" onclick="window.location = 'https://www.oferty.net/mieszkanie-na-wynajem-sw-teresy-lodz-44m2-2-pokoje-2500-pln-ba,1543065361'; return false;">
<td class="cell_photo"><img alt="Mieszkanie do wynajęcia - św. Teresy od Dzieciątka Jezus Bałuty, Łódź, Łódź M., 44 m², 2500 PLN, NET-PTY-MW-6980-3" data-original="https://img2.staticoferty.net.pl/thumbnail/offer3.jpg" /></td>
<td class="cell_location"><a title="mieszkanie na wynajem Łódź, Bałuty" href="https://www.oferty.net/mieszkanie-na-wynajem-sw-teresy-lodz-44m2-2-pokoje-2500-pln-ba,1543065361">mieszkanie&nbsp;na&nbsp;wynajem<br/>Łódź, Bałuty</a></td>
<td class="cell_area">44 m²</td>
<td class="cell_rooms">2</td>
<td class="cell_price">2 500</td>
<td class="cell_price_m2">56,82</td>
<td class="cell_added_at">18:30<br/>2026-10-02</td>
</tr>
</table>
<div class="paginator"><li class="navigate current"><div><a>1</a></div></li><li class="navigate"><div><a href="?page=2">2</a></div></li></div>`;

test("the real oferty.net public page structure (plain <table class=\"property\"> rows, captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const parsed = EXTERNAL_PORTAL_PARSERS.oferty_net(OFERTY_NET_REAL_PAGE_1, "Łódź");
  assert.equal(parsed.listings.length, 2, "the rental row ('na wynajem'/'do wynajęcia') must be filtered out, never kept as a sale listing");
  assert.equal(parsed.hasNextPage, true, "the numbered paginator's page 2 must be detected even with no rel=\"next\" marker");
  const [first, second] = parsed.listings;
  assert.equal(first?.price, 425000);
  assert.equal(first?.area, 41);
  assert.equal(first?.rooms, 2);
  assert.equal(first?.city, "Łódź");
  assert.equal(first?.district, "Dąbrowa");
  assert.equal(first?.externalListingId, "1543094322", "the id must be recovered from the URL's trailing ',<id>' segment since the real site has no id attribute");
  assert.equal(second?.price, 409000);
  assert.equal(second?.district, "Retkinia");

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", first!, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 425000);
});

const OFERTY_NET_DETAIL_OBSERVED_PAGE = `
<title>Mieszkanie na sprzeda&#380; | oferty.net</title>
<div class="header">
  <span>Mieszkanie na sprzeda&#380;</span>
  <h1>&#321;&#243;d&#378;, &#346;r&oacute;dmie&#347;cie, Stefana Jaracza</h1>
  <h3>Pow.: 83,61 m2, Cena: 735 000 PLN</h3>
</div>
<div class="param"><dl>
  <dt>Powierzchnia u&#380;ytkowa</dt><dd>83,61 m2</dd>
  <dt>Typ budynku</dt><dd>APARTAMENTOWIEC</dd>
  <dt>Rynek pierwotny</dt><dd>Nie</dd>
  <dt>Stan nieruchomo&#347;ci</dt><dd>DO WYKO&#323;CZENIA</dd>
</dl></div>
<div class="description">Stan deweloperski, do wyko&#324;czenia.</div>`;

test("Oferty.net detail fetch overrides search-card values with confirmed total price/location/building/market and excludes unfinished stock", async () => {
  const previousFetch = globalThis.fetch;
  const urls: string[] = [];
  const candidatePage = `<table><tr class="property"><td class="cell_photo"><img alt="Mieszkanie na sprzeda&#380; &#321;&#243;d&#378;" src="https://cdn.example/oferta.jpg"></td><td class="cell_location"><a href="https://www.oferty.net/mieszkanie-lodz-srodmiescie-jaracza,offer-1" title="mieszkanie na sprzeda&#380;">Mieszkanie &#321;&#243;d&#378;</a></td><td class="cell_area">53 m2</td><td class="cell_rooms">2</td><td class="cell_price">489 000</td></tr></table>`;
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return new Response(url.includes("/mieszkania,lodz") ? candidatePage : OFERTY_NET_DETAIL_OBSERVED_PAGE, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const result = await fetchExternalPortal(config("oferty_net"), filter, undefined, {
      purpose: "price_radar", deadlineAt: Date.now() + 50_000,
      onBatch: async () => undefined,
    });
    const listing = result.listings[0]!;
    assert.equal(urls.filter((url) => url.includes("/mieszkania,lodz")).length, 1, "the existing result adapter supplies the candidate page");
    assert.equal(urls.filter((url) => url.includes(",offer-1")).length, 1, "the existing adapter fetches that candidate's own detail URL once");
    assert.equal(listing.price, 735_000, "Radar uses the detail page's total price, not the search card price");
    assert.equal(listing.area, 83.61);
    assert.equal(listing.city, "\u0141\u00f3d\u017a");
    assert.equal(listing.district, "\u015ar\u00f3dmie\u015bcie");
    assert.equal(listing.buildingType, "apartamentowiec");
    assert.equal(listing.rawPayload.marketType, "secondary");
    assert.equal(listing.rawPayload.detailVerified, true, "the page has explicit evidence for all required detail fields");
    const qualification = qualifyRadarCandidate({
      source: listing.source, externalListingId: listing.externalListingId, originalUrl: listing.originalUrl, normalizedUrl: listing.normalizedUrl,
      title: listing.title, description: listing.description, price: listing.price, area: listing.area, pricePerSqm: listing.pricePerSqm,
      rooms: listing.rooms, city: listing.city, district: listing.district, buildingType: listing.buildingType,
      marketType: String(listing.rawPayload.marketType), propertyType: "apartment", rawPayload: listing.rawPayload, contentHash: listing.contentHash,
    });
    assert.deepEqual(qualification, { qualified: false, reason: "unfinished_or_needs_renovation" }, "confirmed price and property details do not override a developer-state/unfinished exclusion");
  } finally { globalThis.fetch = previousFetch; }
});

test("Domiporta detail parser marks an observed archived apartment inactive and never verifiable for Radar", () => {
  const archived = `<title>Mieszkanie na sprzeda&#380;</title><h1>Mieszkanie na sprzeda&#380;, 60 m2</h1><div class="summary__location">&#321;&#243;d&#378;, Ba&#322;uty, Wa&#322;brzyska</div><div class="archive__title">Og&#322;oszenie jest ju&#380; nieaktualne</div><div class="summary__price_number">330 000 z&#322;</div><dl><dt class="features__item_name">Powierzchnia</dt><dd class="features__item_value">60 m2</dd></dl>`;
  const parsed = parseRadarOfferDetail("domiporta", archived);
  assert.equal(parsed.active, false);
  assert.equal(parsed.price, 330_000, "the detail price is read as a total amount");
  assert.equal(parsed.area, 60);
  assert.equal(parsed.city, "\u0141\u00f3d\u017a");
  assert.equal(parsed.district, "Ba\u0142uty");
  assert.equal(parsed.verified, false);
});

test("Radar detail cursor resumes after three completed detail pages without repeating their requests", async () => {
  const previousFetch = globalThis.fetch;
  const detailUrls: string[] = [];
  const rows = [1, 2, 3, 4].map((index) => {
    const item = listingValues(`detail-${index}`, "oferty_net", 1);
    const url = `https://www.oferty.net/mieszkanie-lodz-srodmiescie,detail-${index}`;
    return `<tr class="property"><td class="cell_photo"><img alt="${item.title}" src="${item.images[0]}"></td><td class="cell_location"><a href="${url}" title="mieszkanie na sprzeda&#380;">${item.title}</a></td><td class="cell_area">53 m2</td><td class="cell_rooms">2</td><td class="cell_price">489 000</td></tr>`;
  }).join("");
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/mieszkania,lodz")) return new Response(`<table>${rows}</table>`, { status: 200 });
    detailUrls.push(url);
    return new Response(OFERTY_NET_DETAIL_OBSERVED_PAGE, { status: 200 });
  };
  try {
    let savedCursor: unknown = null;
    const firstContext = { purpose: "price_radar" as const, deadlineAt: Date.now() + 50_000, onBatch: async (_batch: unknown, cursor: unknown) => { savedCursor = cursor; } };
    await assert.rejects(fetchExternalPortal(config("oferty_net"), filter, undefined, firstContext as never), /SOURCE_BATCH_YIELD:detail_batch_limit/);
    assert.deepEqual(savedCursor, { kind: "radar_detail_v1", page: 1, candidateIndex: 3 });
    assert.equal(detailUrls.length, 3);

    let finalCursor: unknown = "not-null";
    const resumed = await fetchExternalPortal(config("oferty_net"), filter, undefined, {
      purpose: "price_radar", radarDetailCursor: savedCursor as never, deadlineAt: Date.now() + 50_000,
      onBatch: async (_batch, cursor) => { finalCursor = cursor; },
    });
    assert.equal(detailUrls.length, 4, "the three completed detail pages are not fetched a second time");
    assert.equal(new Set(detailUrls).size, 4);
    assert.equal(resumed.listings.length, 1);
    assert.equal(finalCursor, null, "the adapter marks the detail queue complete only after the last candidate");
  } finally { globalThis.fetch = previousFetch; }
});

// Real public page excerpt (read-only GET of allegrolokalnie.pl's category
// page /oferty/nieruchomosci/mieszkania-na-sprzedaz-112739/lodz, 2026-10-03),
// trimmed to 2 of the page's real 60 items. Every field here (name, url,
// price, image) is read verbatim from the real JSON-LD; there genuinely is
// no room count anywhere on this site.
const ALLEGRO_LOKALNIE_REAL_PAGE_1 = JSON.stringify({
  "@context": "https://schema.org", "@type": "ItemList",
  itemListElement: [
    { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Mieszkanie, Łódź, Górna, Dąbrowa, 41 m²", url: "https://allegrolokalnie.pl/oferta/mieszkanie-lodz-gorna-dabrowa-41-m2-5i3", category: "Mieszkania na sprzedaż", itemCondition: "https://schema.org/UsedCondition", image: { "@type": "ImageObject", url: "https://a.allegroimg.com/original/1172c6/offer1.jpg", contentUrl: "https://a.allegroimg.com/original/1172c6/offer1.jpg" }, offers: { "@type": "Offer", price: "425000", priceCurrency: "PLN" } } },
    { "@type": "ListItem", position: 2, item: { "@type": "Product", name: "Mieszkanie, Łódź, Polesie, 30 m²", url: "https://allegrolokalnie.pl/oferta/mieszkanie-lodz-polesie-30-m2-mrm", category: "Mieszkania na sprzedaż", itemCondition: "https://schema.org/UsedCondition", image: { "@type": "ImageObject", url: "https://a.allegroimg.com/original/1172c6/offer2.jpg", contentUrl: "https://a.allegroimg.com/original/1172c6/offer2.jpg" }, offers: { "@type": "Offer", price: "351364", priceCurrency: "PLN" } } },
  ],
});

test("the real allegrolokalnie.pl public page structure (flat ItemList, name-only area/district, captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const html = `<script type="application/ld+json">${ALLEGRO_LOKALNIE_REAL_PAGE_1}</script><input class="ml-pagination__input" value="1"><span class="ml-pagination__count">z 40</span>`;
  const parsed = EXTERNAL_PORTAL_PARSERS.allegro_lokalnie(html, "Łódź");
  assert.equal(parsed.listings.length, 2);
  assert.equal(parsed.hasNextPage, true, "page 1 of 40 must report a next page from the pagination widget's own current/total count");
  const [first, second] = parsed.listings;
  assert.equal(first?.price, 425000);
  assert.equal(first?.area, 41);
  assert.equal(first?.rooms, null, "the real site has no room count anywhere; it must stay null, never fabricated");
  assert.equal(first?.city, "Łódź");
  assert.equal(first?.district, "Górna, Dąbrowa");
  assert.equal(first?.externalListingId, "mieszkanie-lodz-gorna-dabrowa-41-m2-5i3", "the id must be recovered from the URL since the real site has no sku/productID anywhere");
  assert.equal(second?.price, 351364);
  assert.equal(second?.district, "Polesie");

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", first!, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 425000);
});

// Real markup shape (read-only GET of allegrolokalnie.pl's Łódź category
// page, 2026-10-03): each card's own <ul class="mlc-itembox__params"> lists
// explicit labeled parameters ("Rynek:", "Rok budowy:", "Typ budynku:") as
// separate <li> entries, entirely outside the JSON-LD block used above for
// price/area/title -- this is the ONLY place a construction year ever
// appears on this source. The two blocks describe the same offer via
// different URL forms (a relative card href vs. an absolute JSON-LD url),
// which is why the parser correlates them by pathname.
test("Allegro Lokalnie: a 1897 building with no stated building type is read from the explicit 'Rok budowy' label, never guessed from age or the word 'cegła' elsewhere in the title", () => {
  const path = "/oferta/mieszkanie-lodz-pilsudskiego-32-5-m2-xyz";
  const jsonLdBlock = jsonLd({
    "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: [
      {
        "@type": "ListItem", position: 1,
        item: {
          "@type": "Product",
          name: "Mieszkanie, Łódź, ul. Piłsudskiego, cegła, 32,5 m²",
          url: `https://allegrolokalnie.pl${path}`,
          offers: { "@type": "Offer", price: "250000", priceCurrency: "PLN" },
          image: { "@type": "ImageObject", url: "https://a.allegroimg.com/original/offer.jpg" },
        },
      },
    ],
  });
  // Deliberately has NO "Typ budynku" <li> at all -- the task's own test
  // premise ("typ budynku nie jest podany wprost") -- only "Rynek" and "Rok
  // budowy" are present, exactly like a real card that lacks that one field.
  const card = `<article class="mlc-itembox__container" itemscope itemtype="http://schema.org/Offer"><a href="${path}?navCategoryId=" itemprop="url" class="mlc-card mlc-itembox"><div class="mlc-itembox__offer-container"><div class="mlc-itembox__offer-info-container"><ul class="mlc-itembox__params" itemprop="description"><li class="mlc-itembox__params__param"><div class="ml-text-small">Rynek: <span class="mlc-itembox__params__param__name"> wtórny</span></div></li><li class="mlc-itembox__params__param"><div class="ml-text-small">Rok budowy: <span class="mlc-itembox__params__param__name"> 1897</span></div></li></ul></div></div></a></article>`;
  const html = `${jsonLdBlock}${card}<input class="ml-pagination__input" value="1"><span class="ml-pagination__count">z 1</span>`;

  const parsed = EXTERNAL_PORTAL_PARSERS.allegro_lokalnie(html, "Łódź");
  assert.equal(parsed.listings.length, 1);
  const listing = parsed.listings[0]!;
  assert.equal(listing.area, 32.5);
  assert.equal(listing.yearBuilt, 1897, "the explicit 'Rok budowy' label must be read as a real number");
  assert.equal(listing.buildingType, null, "buildingType must stay null -- never inferred from the 1897 age or the word 'cegła' in the title");
});

test("Allegro Lokalnie: a card with no 'Rok budowy' parameter at all leaves yearBuilt null, never a guess from the free-text name", () => {
  const path = "/oferta/mieszkanie-lodz-no-year-abc";
  const jsonLdBlock = jsonLd({
    "@context": "https://schema.org", "@type": "ItemList",
    itemListElement: [
      { "@type": "ListItem", position: 1, item: { "@type": "Product", name: "Mieszkanie, Łódź, 40 m²", url: `https://allegrolokalnie.pl${path}`, offers: { "@type": "Offer", price: "300000", priceCurrency: "PLN" }, image: { "@type": "ImageObject", url: "https://a.allegroimg.com/original/offer2.jpg" } } },
    ],
  });
  const card = `<article class="mlc-itembox__container" itemscope itemtype="http://schema.org/Offer"><a href="${path}" itemprop="url" class="mlc-card mlc-itembox"><div class="mlc-itembox__offer-container"><div class="mlc-itembox__offer-info-container"><ul class="mlc-itembox__params" itemprop="description"><li class="mlc-itembox__params__param"><div class="ml-text-small">Rynek: <span class="mlc-itembox__params__param__name"> wtórny</span></div></li></ul></div></div></a></article>`;
  const html = `${jsonLdBlock}${card}<input class="ml-pagination__input" value="1"><span class="ml-pagination__count">z 1</span>`;

  const parsed = EXTERNAL_PORTAL_PARSERS.allegro_lokalnie(html, "Łódź");
  assert.equal(parsed.listings.length, 1);
  assert.equal(parsed.listings[0]?.yearBuilt, null);
});

// Real public page excerpt (read-only GET of domy.pl/mieszkania--lodz-pl,
// 2026-10-03), trimmed to 3 of the page's real 25 cards -- including one
// genuine rental row ("do wynajęcia"), which must be filtered out rather
// than kept as a sale listing, and a "Kawalerka" (studio) row to prove the
// Polish room-word lookup covers more than just the "<N>pokojowe" pattern.
const DOMY_REAL_PAGE_1 = `
<article class="propertyBox first L">
<a class="property_link" href="https://domy.pl/mieszkanie/lodz-gorna-senatorska-2-pokoje-240000-pln-40m2-sfb/dol1738212431" title="Dwupokojowe mieszkanie na sprzedaż Łódź, Górna, Senatorska">Łódź, Górna, Senatorska </a>
<span class="area">40 m²</span>
<span class="price">240 000&nbsp;PLN</span>
</article>
<article class="propertyBox L">
<a class="property_link" href="https://domy.pl/mieszkanie/lodz-polesie-stefanowskiego-kawalerka-dol1538017548" title="Kawalerka na sprzedaż Łódź, Polesie, ul. Stefanowskiego">Łódź, Polesie, ul. Stefanowskiego </a>
<span class="area">26 m²</span>
<span class="price">245 000&nbsp;PLN</span>
</article>
<article class="propertyBox L">
<a class="property_link" href="https://domy.pl/mieszkanie/lodz-baluty-wroblewskiego-kawalerka-wynajem-dol1543059967" title="Kawalerka do wynajęcia Łódź, Górna, Wróblewskiego">Łódź, Górna, Wróblewskiego </a>
<span class="area">26 m²</span>
<span class="price">1 450&nbsp;PLN</span>
</article>
<a rel="next" href="/mieszkania--lodz-pl?page=2">next</a>`;

test("the real domy.pl public page structure (<article class=\"propertyBox\"> cards, Polish room-count words, captured 2026-10-03) reaches persistListing and the Finder gate", async () => {
  const parsed = EXTERNAL_PORTAL_PARSERS.domy(DOMY_REAL_PAGE_1, "Łódź");
  assert.equal(parsed.listings.length, 2, "the rental row ('do wynajęcia') must be filtered out, never kept as a sale listing");
  assert.equal(parsed.hasNextPage, true);
  const [first, second] = parsed.listings;
  assert.equal(first?.price, 240000);
  assert.equal(first?.area, 40);
  assert.equal(first?.rooms, 2, "'Dwupokojowe' must resolve to 2 rooms via the Polish word lookup, not a numeric field");
  assert.equal(first?.city, "Łódź");
  assert.equal(first?.district, "Górna, Senatorska");
  assert.equal(first?.externalListingId, "dol1738212431", "the id must be recovered from the URL's trailing dol<digits> segment");
  assert.equal(second?.price, 245000);
  assert.equal(second?.rooms, 1, "'Kawalerka' (studio) must resolve to 1 room");

  const rows: Record<string, unknown>[] = [];
  const db = fakeDb(rows);
  const { persistListing } = await import("./server/persist-listing.ts");
  const persisted = await persistListing(db as never, "filter-1", first!, true, [], "scan-1", "2026-10-03T10:00:00Z", AbortSignal.timeout(1000));
  assert.ok(persisted.listingId, "the real listing must reach the canonical listings table");
  assert.equal(rows[0]?.price, 240000);
});

test("the registry exposes every new adapter for the schema gate", () => {
  assert.deepEqual(SOURCES.filter((source) => SOURCE_IDS.includes(source.id as ExternalSourceId)).map((source) => source.id), SOURCE_IDS);
});
