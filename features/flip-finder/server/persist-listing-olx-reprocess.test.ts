import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Re-processing OLX offers (stage-2 run 38460045910 follow-up): the same
 * offer seen again must update its one record, never add a copy -- also
 * after the seller edits the title, which changes both the legacy external
 * id (the URL slug) and the normalized URL, but not OLX's "-ID<token>".
 */

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });
mock.module("@/features/flip-finder/server/listing-ai-analysis", { namedExports: { analyzeListingWithAiIfNeeded: async () => undefined } });

type Row = Record<string, unknown>;

/** Just enough of the Supabase query builder for persistListing, including like() and order(). */
function fakeDb(rows: Row[], log: string[]) {
  let sequence = 0;
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let operation: "select" | "upsert" | "insert" | "update" = "select";
      let payload: Row | null = null;
      let newestFirst = false;
      const matching = () => (table === "listings" ? rows : []).filter((row) => filters.every((filter) => filter(row)));
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters.push((row) => row[key] === value); return builder; },
        like: (key: string, pattern: string) => {
          log.push(`like ${pattern}`);
          assert.ok(pattern.startsWith("%") && !pattern.slice(1).includes("%") && !pattern.includes("_"), "only a trailing-suffix pattern without wildcards");
          filters.push((row) => typeof row[key] === "string" && (row[key] as string).endsWith(pattern.slice(1)));
          return builder;
        },
        filter: () => builder,
        order: (key: string, options?: { ascending?: boolean }) => { newestFirst = key === "last_seen_at" && options?.ascending === false; return builder; },
        limit: () => builder,
        abortSignal: () => builder,
        insert: (value: Row) => { operation = "insert"; payload = value; return builder; },
        update: (value: Row) => { operation = "update"; payload = value; return builder; },
        upsert: (value: Row) => { operation = "upsert"; payload = value; return builder; },
        maybeSingle: async () => {
          const found = matching();
          if (newestFirst) found.sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
          return { data: found[0] ?? null, error: null };
        },
        async single() {
          if (table === "listings" && operation === "upsert" && payload) {
            const existing = rows.find((row) => row.source === payload?.source && row.external_listing_id === payload?.external_listing_id);
            if (existing) Object.assign(existing, payload);
            else rows.push({ ...payload, id: `listing-${++sequence}` });
            return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null };
          }
          return { data: { id: `row-${++sequence}` }, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
      };
      return builder;
    },
  };
}

const { persistListing } = await import("./persist-listing.ts");
const { parseOlxHtml } = await import("../olx-parser.ts");

function olxListing(options: { title: string; slug: string; price: number }) {
  const ad = {
    id: 1_000_001,
    title: options.title,
    description: "<p>Teofilów, 2 pokoje, blok.</p>",
    url: `https://www.olx.pl/d/oferta/${options.slug}-CID3-IDTEOF1.html`,
    params: [
      { key: "m", value: "37,07 m²", normalizedValue: "37.07" },
      { key: "rooms", value: "two", normalizedValue: "two" },
      { key: "builttype", value: "blok", normalizedValue: "blok" },
    ],
    price: { regularPrice: { value: options.price, currencyCode: "PLN" } },
    location: { cityName: "Łódź", districtName: "Bałuty" },
    photos: [],
  };
  const state = JSON.stringify({ listing: { listing: { ads: [ad] } } });
  const [listing] = parseOlxHtml(`<script>window.__PRERENDERED_STATE__ = ${JSON.stringify(state)};</script>`).listings;
  assert.ok(listing);
  return listing;
}

const persist = (rows: Row[], log: string[], listing: ReturnType<typeof olxListing>, at: string) =>
  persistListing(fakeDb(rows, log) as never, "filter-1", listing, true, [], "scan-1", at, AbortSignal.timeout(1000), { bucket: "MATCHED", reasons: [], unknownFields: [] });

test("processing the same OLX offer again updates its one record: not created, not counted as updated", async () => {
  const rows: Row[] = [];
  const log: string[] = [];
  const listing = olxListing({ title: "Najciekawsze Mieszkanie NA Teofilowie", slug: "najciekawsze-mieszkanie-na-teofilowie", price: 238_000 });
  const first = await persist(rows, log, listing, "2026-10-13T20:06:00Z");
  const second = await persist(rows, log, listing, "2026-10-14T20:06:00Z");
  assert.equal(rows.length, 1);
  assert.equal(first.listingCreated, true);
  assert.equal(second.listingCreated, false);
  assert.equal(second.updated, 0, "an unchanged offer is not an update");
  assert.equal(second.priceDrop, 0);
  assert.equal(second.listingId, first.listingId);
});

test("a price drop on the next scan updates the same record and counts one price drop", async () => {
  const rows: Row[] = [];
  const log: string[] = [];
  await persist(rows, log, olxListing({ title: "Najciekawsze Mieszkanie NA Teofilowie", slug: "najciekawsze-mieszkanie-na-teofilowie", price: 238_000 }), "2026-10-13T20:06:00Z");
  const next = await persist(rows, log, olxListing({ title: "Najciekawsze Mieszkanie NA Teofilowie", slug: "najciekawsze-mieszkanie-na-teofilowie", price: 229_000 }), "2026-10-14T20:06:00Z");
  assert.equal(rows.length, 1);
  assert.equal(next.updated, 1);
  assert.equal(next.priceDrop, 1);
  assert.equal(rows[0]?.price, 229_000);
});

test("a title edit (new slug: new legacy id and new URL) reuses the record found by the OLX -ID token", async () => {
  const rows: Row[] = [];
  const log: string[] = [];
  const before = olxListing({ title: "Najciekawsze Mieszkanie NA Teofilowie", slug: "najciekawsze-mieszkanie-na-teofilowie", price: 238_000 });
  const after = olxListing({ title: "Teofilów, 2 pokoje, po remoncie", slug: "teofilow-2-pokoje-po-remoncie", price: 238_000 });
  assert.notEqual(before.externalListingId, after.externalListingId);
  const first = await persist(rows, log, before, "2026-10-13T20:06:00Z");
  const edited = await persist(rows, log, after, "2026-10-14T20:06:00Z");
  assert.equal(rows.length, 1, "no second record for the same ad");
  assert.equal(edited.listingId, first.listingId);
  assert.equal(edited.listingCreated, false);
  assert.equal(rows[0]?.external_listing_id, before.externalListingId, "the stored id is kept (Radar and matches keep pointing at it)");
  assert.equal(rows[0]?.title, "Teofilów, 2 pokoje, po remoncie");
  assert.equal(rows[0]?.normalized_url, after.normalizedUrl, "the record now carries the current URL, so the next scan finds it by URL");
  // One token lookup when the ad was new, one after the edit: only when id and URL found nothing.
  assert.deepEqual(log, ["like %-IDTEOF1.html", "like %-IDTEOF1.html"]);

  const again = await persist(rows, log, after, "2026-10-15T20:06:00Z");
  assert.equal(again.listingId, first.listingId);
  assert.equal(log.length, 2, "found by URL this time, no token lookup");
});

test("a genuinely new OLX ad (unknown token) is still created", async () => {
  const rows: Row[] = [{ id: "other", source: "olx", external_listing_id: "other-ad-CID3-IDZZZ9.html", normalized_url: "https://olx.pl/d/oferta/other-ad-CID3-IDZZZ9.html", price: 300_000, content_hash: "x", images: [], last_seen_at: "2026-10-01T00:00:00Z" }];
  const log: string[] = [];
  const created = await persist(rows, log, olxListing({ title: "Najciekawsze Mieszkanie NA Teofilowie", slug: "najciekawsze-mieszkanie-na-teofilowie", price: 238_000 }), "2026-10-13T20:06:00Z");
  assert.equal(created.listingCreated, true);
  assert.equal(rows.length, 2);
});
