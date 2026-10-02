import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { OFFICIAL_LODZ_PARSERS, fetchOfficialLodzGroup, fetchOfficialSource, type OfficialCanonicalSource } from "./official-lodz-adapters.ts";
import { OFFICIAL_LODZ_SOURCES } from "./official-lodz-sources.ts";

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });

const saleSources = OFFICIAL_LODZ_SOURCES.filter((source) => source.kind !== "rental_program");

function fixture(sourceId: string, includeExcluded = false): string {
  const source = OFFICIAL_LODZ_SOURCES.find((item) => item.id === sourceId)!;
  const notice = `<${source.kind === "municipal" ? "tr" : "article"} data-notice-id="notice-42" data-auction-id="auction-42" data-url="${source.url}offers/notice-42" data-city="Łódź" data-district="Bałuty" data-price="430.000 zł" data-deposit="43 000 zł" data-deadline="2026-11-15 12:00" data-event-date="2026-11-20 10:00" data-area="52,97 m²" data-rooms="3"><td><a href="${source.url}offers/notice-42"><h2>Lokal mieszkalny — sprzedaż</h2></a><ul data-field="criteria"><li>wadium wpłacone przed licytacją</li></ul></td><img src="https://cdn.example/official-42.jpg" /></${source.kind === "municipal" ? "tr" : "article"}>`;
  const excluded = includeExcluded ? `<article data-notice-id="works-1" data-url="${source.url}works-1" data-city="Łódź" data-price="99 000 zł" data-area="50 m²"><a href="${source.url}works-1"><h2>Remont i roboty budowlane lokalu użytkowego</h2></a></article>` : "";
  return source.kind === "municipal" ? `<table>${notice}${excluded}</table>` : `<main>${notice}${excluded}</main>`;
}

test("every public sale source has a dedicated parser and preserves official offer fields", () => {
  for (const source of saleSources) {
    const result = OFFICIAL_LODZ_PARSERS[source.id]!(fixture(source.id), source);
    assert.equal(result.listings.length, 1, source.id);
    const listing = result.listings[0]!;
    const metadata = listing.officialOffer;
    assert.equal(listing.externalListingId, `${source.id}:notice-42`);
    assert.equal(listing.price, 430000, source.id);
    assert.equal(listing.area, 52.97, source.id);
    assert.equal(listing.originalUrl, `${source.url}offers/notice-42`);
    assert.equal(metadata?.sourceId, source.id);
    assert.equal(metadata?.deposit, 43000, source.id);
    assert.equal(metadata?.deadline, "2026-11-15 12:00", source.id);
    assert.equal(metadata?.eventDate, "2026-11-20 10:00", source.id);
    assert.deepEqual(metadata?.eligibilityCriteria, ["wadium wpłacone przed licytacją"], source.id);
  }
});

test("mixed official pages keep residential sales and exclude works, services, and commercial units", () => {
  for (const source of saleSources) {
    const result = OFFICIAL_LODZ_PARSERS[source.id]!(fixture(source.id, true), source);
    assert.equal(result.listings.length, 1, source.id);
    assert.equal(result.listings[0]?.externalListingId, `${source.id}:notice-42`, source.id);
  }
  const rental = OFFICIAL_LODZ_SOURCES.find((source) => source.kind === "rental_program")!;
  assert.equal(OFFICIAL_LODZ_PARSERS[rental.id], undefined);
});

test("official source fetch is read-only, host-bound, and fails closed for unavailable responses", async () => {
  const source = saleSources[0]!;
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(fixture(source.id), { status: 200, headers: { "content-type": "text/html" } });
    const result = await fetchOfficialSource(source.id, { city: "Łódź" });
    assert.equal(result.listings.length, 1);
    globalThis.fetch = async () => new Response("blocked", { status: 403 });
    await assert.rejects(fetchOfficialSource(source.id, { city: "Łódź" }), /HTTP 403/);
    const foreign = fixture(source.id).replaceAll(source.url, "https://evil.example/");
    const parsed = OFFICIAL_LODZ_PARSERS[source.id]!(foreign, source);
    assert.equal(parsed.listings.length, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test("the grouped registry flow reaches every source parser before canonical persistence", async () => {
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      const source = saleSources.find((item) => url.startsWith(item.url));
      assert.ok(source, `unexpected official request: ${url}`);
      return new Response(fixture(source.id), { status: 200, headers: { "content-type": "text/html" } });
    };
    for (const [group, expected] of [["official_cooperative", saleSources.filter((source) => source.kind === "cooperative").length], ["official_uml", saleSources.filter((source) => source.kind === "municipal").length], ["official_auction", saleSources.filter((source) => source.kind === "krk" || source.kind === "syndic").length]] as const) {
      const result = await fetchOfficialLodzGroup(group, { city: "Łódź" });
      assert.equal(result.listings.length, expected, group);
      assert.equal(result.listings.every((listing) => Boolean(listing.officialOffer?.sourceId)), true, group);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("official listings remain idempotent through persistListing and retain metadata in the snapshot", async () => {
  const { persistListing } = await import("./server/persist-listing.ts");
  const rows: Record<string, unknown>[] = [];
  const snapshots: Record<string, unknown>[] = [];
  const db = fakeDb(rows, snapshots);
  const groups = new Set<OfficialCanonicalSource>();
  for (const source of saleSources) {
    const listing = OFFICIAL_LODZ_PARSERS[source.id]!(fixture(source.id), source).listings[0]!;
    groups.add(listing.source as OfficialCanonicalSource);
    const first = await persistListing(db as never, "filter-official", listing, true, [], "scan-official", "2026-10-02T10:00:00Z", AbortSignal.timeout(1000));
    const second = await persistListing(db as never, "filter-official", listing, true, [], "scan-official", "2026-10-02T10:01:00Z", AbortSignal.timeout(1000));
    assert.equal(first.listingId, second.listingId, source.id);
  }
  assert.deepEqual([...groups].sort(), ["official_auction", "official_cooperative", "official_uml"]);
  assert.equal(rows.length, saleSources.length);
  assert.equal(snapshots.filter((row) => row.raw_data && typeof row.raw_data === "object" && "officialOffer" in (row.raw_data as object)).length, saleSources.length);
});

function fakeDb(rows: Record<string, unknown>[], snapshots: Record<string, unknown>[]) {
  let sequence = 0;
  return { from(table: string) { const filters: Record<string, unknown> = {}; let operation = "select"; let payload: Record<string, unknown> | null = null; const builder: Record<string, unknown> = { select: () => builder, eq: (key: string, value: unknown) => { filters[key] = value; return builder; }, order: () => builder, limit: () => builder, abortSignal: () => builder, insert: (value: Record<string, unknown>) => { operation = "insert"; payload = value; return builder; }, upsert: (value: Record<string, unknown>) => { operation = "upsert"; payload = value; return builder; }, maybeSingle: async () => ({ data: rows.find((row) => Object.entries(filters).every(([key, value]) => row[key] === value)) ?? null, error: null }), single: async () => { if (table === "listings" && operation === "upsert" && payload) { const existing = rows.find((row) => row.source === payload?.source && row.external_listing_id === payload?.external_listing_id); if (existing) Object.assign(existing, payload); else rows.push({ ...payload, id: `listing-${++sequence}` }); return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null }; } return { data: { id: `row-${++sequence}` }, error: null }; }, then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => { if (table === "listing_snapshots" && operation === "insert" && payload) snapshots.push(payload); return Promise.resolve({ data: [], error: null }).then(resolve, reject); } }; return builder; } };
}
