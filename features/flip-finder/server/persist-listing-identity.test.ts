import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { normalizeOtodomUrl } from "../otodom-search.ts";

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });

type Row = Record<string, unknown>;
function fakeDb(rows: Row[]) {
  let sequence = 0;
  const snapshots: Row[] = [];
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let operation: "select" | "upsert" | "insert" = "select";
      let payload: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        order: () => builder,
        limit: () => builder,
        filter: () => builder,
        abortSignal: () => builder,
        insert: (value: Row) => { operation = "insert"; payload = value; return builder; },
        upsert: (value: Row) => { operation = "upsert"; payload = value; return builder; },
        maybeSingle: async () => {
          const row = rows.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value)) ?? null;
          return { data: row, error: null };
        },
        single: async () => {
          if (table === "listings" && operation === "upsert" && payload) {
            const existing = rows.find((candidate) => candidate.source === payload?.source && candidate.external_listing_id === payload?.external_listing_id);
            if (existing) Object.assign(existing, payload);
            else rows.push({ ...payload, id: `listing-${++sequence}` });
            return { data: { id: existing?.id ?? rows.at(-1)?.id }, error: null };
          }
          return { data: { id: `row-${++sequence}` }, error: null };
        },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          if (table === "listing_snapshots" && operation === "insert" && payload) snapshots.push({ ...payload });
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    snapshots,
  };
}

const { persistListing } = await import("./persist-listing.ts");

function listing(externalListingId: string, title: string) {
  return {
    source: "domiporta" as const,
    externalListingId,
    originalUrl: "https://domiporta.pl/oferta/lodz-1?utm_source=feed",
    normalizedUrl: "https://domiporta.pl/oferta/lodz-1",
    title,
    price: 489000,
    area: 53,
    rooms: 2,
    floor: "2",
    pricePerSqm: 9226,
    city: "Łódź",
    district: "Bałuty",
    locationText: "Bałuty, Łódź",
    thumbnailUrl: null,
    images: [],
    buildingType: null,
    description: "Sprzedaż mieszkania",
    publishedAt: null,
    rawPayload: {},
    contentHash: title,
  };
}

function otodomListing(externalListingId: string, url: string) {
  return {
    source: "otodom" as const,
    externalListingId,
    originalUrl: url,
    normalizedUrl: normalizeOtodomUrl(url),
    title: "Mieszkanie Otodom",
    price: 439000,
    area: 50,
    rooms: 2,
    floor: "2",
    pricePerSqm: 8780,
    city: "Łódź",
    district: "Bałuty",
    locationText: "Bałuty, Łódź",
    thumbnailUrl: null,
    images: [],
    buildingType: null,
    description: "Oferta testowa",
    publishedAt: null,
    rawPayload: {},
    contentHash: "otodom-content",
  };
}

test("persistListing reuses a canonical listing when a portal rotates its external id but URL stays stable", async () => {
  const rows: Row[] = [{ id: "canonical-1", source: "domiporta", external_listing_id: "old-id", normalized_url: "https://domiporta.pl/oferta/lodz-1", price: 480000, content_hash: "old", images: [] }];
  const db = fakeDb(rows);
  const first = await persistListing(db as never, "filter-1", listing("new-id", "Nowy tytuł"), true, [], "scan-1", "2026-10-01T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(first.listingId, "canonical-1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_listing_id, "old-id");
  assert.equal(rows[0].title, "Nowy tytuł");
});

test("persistListing treats Otodom .html and extensionless URLs as one canonical listing", async () => {
  const rows: Row[] = [{
    id: "otodom-canonical",
    source: "otodom",
    external_listing_id: "old-otodom-id",
    normalized_url: "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS.html",
    price: 439000,
    content_hash: "old",
    images: [],
  }];
  const db = fakeDb(rows);
  const saved = await persistListing(
    db as never,
    "filter-1",
    otodomListing("new-otodom-id", "https://www.otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS.html?utm_source=feed"),
    true,
    [],
    "scan-otodom",
    "2026-10-01T10:00:00Z",
    AbortSignal.timeout(1000),
  );
  assert.equal(saved.listingId, "otodom-canonical");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_listing_id, "old-otodom-id");
  assert.equal(rows[0].normalized_url, "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS");
});

test("persistListing stores the adapter's confirmed publication date in snapshot raw_data", async () => {
  const rows: Row[] = [];
  const db = fakeDb(rows);
  await persistListing(db as never, "filter-1", { ...listing("published-1", "Oferta z datą"), publishedAt: "2026-10-04T21:55:00.000Z" }, true, [], "scan-1", "2026-10-07T10:00:00.000Z", AbortSignal.timeout(1000));
  assert.equal(rows.length, 1);
  assert.equal(db.snapshots.length, 1);
  assert.equal((db.snapshots[0].raw_data as Row).sourcePublishedAt, "2026-10-04T21:55:00.000Z");
});

test("a non-Facebook reimport without a valid total sale price is rejected before any row or existing price can be changed", async () => {
  const rows: Row[] = [{ id: "canonical-2", source: "domiporta", external_listing_id: "known-id", price: 489000, content_hash: "known", images: [] }];
  const db = fakeDb(rows);
  await assert.rejects(
    persistListing(db as never, "filter-1", { ...listing("known-id", "Existing listing"), price: Number.NaN }, true, [], "scan-2", "2026-10-07T10:00:00.000Z", AbortSignal.timeout(1000)),
    /INVALID_SALE_PRICE/,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 489000);
});
