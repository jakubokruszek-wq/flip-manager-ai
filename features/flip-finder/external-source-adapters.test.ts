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
  if (source === "gratka") return jsonLd({ "@type": "Product", sku: item.id, url: item.url, name: item.title, description: item.description, image: item.images, datePosted: item.publishedAt, offers: { price: item.price }, itemOffered: { floorSize: { value: item.area }, numberOfRooms: item.rooms, address: { addressLocality: item.city, addressSuburb: item.district } } }, next);
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
  globalThis.fetch = async () => new Response("blocked", { status: 403 });
  try { await assert.rejects(fetchExternalPortal(config("domy"), filter), /HTTP 403/); } finally { globalThis.fetch = previousFetch; }
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

test("the registry keeps every new adapter behind the closed schema gate", () => {
  assert.deepEqual(SOURCES.filter((source) => SOURCE_IDS.includes(source.id as ExternalSourceId)).map((source) => source.id), SOURCE_IDS);
});
