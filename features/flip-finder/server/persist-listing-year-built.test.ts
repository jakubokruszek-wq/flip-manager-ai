import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * "Rok budowy od" criterion, persist path. listings.year_built's own
 * migration (supabase/migrations/20261004030000_add_year_built_criterion.sql)
 * is a DRAFT, not applied anywhere by this change. persistListing must never
 * assume it is live: it only reacts to the exact "column does not exist"
 * error, retrying once without year_built -- independently of, and before,
 * the pre-existing review-lifecycle-column fallback -- so a scan is never
 * broken by this one missing optional column.
 */

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });

type Row = Record<string, unknown>;
type Mode = "normal" | "missing-year-built" | "missing-lifecycle";
let mode: Mode = "normal";
let upsertPayloads: Row[] = [];

function fakeDb(rows: Row[]) {
  let sequence = 0;
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let operation: "select" | "upsert" = "select";
      let payload: Row | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (key: string, value: unknown) => { filters[key] = value; return builder; },
        order: () => builder,
        limit: () => builder,
        abortSignal: () => builder,
        insert: (value: Row) => { operation = "upsert"; payload = value; return builder; },
        upsert: (value: Row) => { operation = "upsert"; payload = value; return builder; },
        maybeSingle: async () => ({ data: rows.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value)) ?? null, error: null }),
        async single() {
          if (table === "listings" && operation === "upsert" && payload) {
            upsertPayloads.push(payload);
            if (mode === "missing-year-built" && "year_built" in payload) {
              return { data: null, error: { code: "PGRST204", message: "Could not find the 'year_built' column of 'listings' in the schema cache" } };
            }
            if (mode === "missing-lifecycle" && "lifecycle_status" in payload) {
              return { data: null, error: { code: "PGRST204", message: "Could not find the 'lifecycle_status' column of 'listings' in the schema cache" } };
            }
            const existing = rows.find((candidate) => candidate.source === payload?.source && candidate.external_listing_id === payload?.external_listing_id);
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

function listing(yearBuilt: number | null) {
  return {
    source: "allegro_lokalnie" as const,
    externalListingId: "offer-1",
    originalUrl: "https://allegrolokalnie.pl/oferta/offer-1",
    normalizedUrl: "https://allegrolokalnie.pl/oferta/offer-1",
    title: "Mieszkanie Łódź Piłsudskiego",
    price: 250_000,
    area: 32.5,
    rooms: null,
    floor: null,
    pricePerSqm: 250_000 / 32.5,
    city: "Łódź",
    district: null,
    locationText: "Łódź",
    thumbnailUrl: null,
    images: [],
    buildingType: null,
    yearBuilt,
    description: null,
    publishedAt: null,
    rawPayload: {},
    contentHash: "offer-1",
  };
}

test("a known yearBuilt is sent to the listings upsert as year_built", async () => {
  mode = "normal";
  upsertPayloads = [];
  const rows: Row[] = [];
  await persistListing(fakeDb(rows) as never, "filter-1", listing(1897), true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(upsertPayloads.length, 1);
  assert.equal(upsertPayloads[0]?.year_built, 1897);
  assert.equal(rows[0]?.year_built, 1897);
});

test("if listings.year_built does not exist yet (draft migration not applied), persistListing retries without it and still saves the listing", async () => {
  mode = "missing-year-built";
  upsertPayloads = [];
  const rows: Row[] = [];
  const result = await persistListing(fakeDb(rows) as never, "filter-1", listing(1897), true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(upsertPayloads.length, 2, "must retry exactly once, without year_built, after the column-missing error");
  assert.ok(!("year_built" in upsertPayloads[1]!), "the retried payload must not include the missing column");
  assert.ok(result.listingId, "the listing itself must still be saved -- one missing optional column must never break the whole scan");
  assert.equal(rows[0]?.price, 250_000, "every other field must still reach the retried upsert unchanged");
});

test("the new year_built check correctly ignores an unrelated missing-column error (lifecycle_status), leaving the pre-existing fallback to handle it on its own retry", async () => {
  mode = "missing-lifecycle";
  upsertPayloads = [];
  const rows: Row[] = [];
  const result = await persistListing(fakeDb(rows) as never, "filter-1", listing(null), true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(upsertPayloads.length, 2, "the year_built check must not consume this retry -- only the review-lifecycle fallback should fire, exactly once");
  assert.ok(result.listingId, "the listing must still be saved even when the review-lifecycle columns are missing");
  assert.ok(!("lifecycle_status" in rows[0]!), "the final persisted row must reflect the legacy (lifecycle-free) shape");
});
