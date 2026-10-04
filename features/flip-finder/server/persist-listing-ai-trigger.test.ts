import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Verifies ONLY the wiring in persistListing: does it call the AI analyzer
 * exactly when a listing is newly created or its content changed, and
 * never otherwise, and never let a failure from it propagate out. The
 * analyzer's own logic (schema, caching, confirmedListingImages, timeouts)
 * is tested in isolation in listing-ai-analysis.test.ts -- this file mocks
 * that module entirely, so no real fetch/API call is reachable from here
 * either.
 */

mock.module("@/features/flip-finder/listing-images", { namedExports: { resolveListingImages: (existing: string[], thumbnail: string | null, images?: string[]) => [...new Set([...existing, ...(thumbnail ? [thumbnail] : []), ...(images ?? [])])] } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => ({ saved: false, created: false, compId: null, available: true }) } });
mock.module("@/features/flip-finder/server/canonical-reconciliation", { namedExports: { reconcileCanonicalListingDecision: async () => ({ isCurrentMatch: true }) } });

let analyzeCalls: Array<{ listingId: string; description: string | null }> = [];
let analyzeShouldThrow = false;
mock.module("./listing-ai-analysis.ts", {
  namedExports: {
    analyzeListingWithAiIfNeeded: async (_supabase: unknown, listingId: string, item: { description: string | null }) => {
      analyzeCalls.push({ listingId, description: item.description });
      if (analyzeShouldThrow) throw new Error("simulated analyzer failure");
    },
    confirmedListingImages: () => [],
  },
});

type Row = Record<string, unknown>;
function fakeDb(rows: Row[]) {
  let sequence = 0;
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
        abortSignal: () => builder,
        insert: (value: Row) => { operation = "insert"; payload = value; return builder; },
        upsert: (value: Row) => { operation = "upsert"; payload = value; return builder; },
        maybeSingle: async () => ({ data: rows.find((candidate) => Object.entries(filters).every(([key, value]) => candidate[key] === value)) ?? null, error: null }),
        single: async () => {
          if (table === "listings" && operation === "upsert" && payload) {
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

function listing(externalListingId: string, overrides: Partial<Row> = {}) {
  return {
    source: "otodom" as const,
    externalListingId,
    originalUrl: `https://otodom.pl/oferta/${externalListingId}`,
    normalizedUrl: `https://otodom.pl/oferta/${externalListingId}`,
    title: "Mieszkanie",
    price: 400_000,
    area: 50,
    rooms: 2,
    floor: "2",
    pricePerSqm: 8_000,
    city: "Łódź",
    district: "Bałuty",
    locationText: "Bałuty, Łódź",
    thumbnailUrl: null,
    images: [],
    buildingType: null,
    description: "Opis oferty",
    publishedAt: null,
    rawPayload: {},
    contentHash: `hash-${externalListingId}`,
    ...overrides,
  };
}

test("a brand-new listing triggers the AI analyzer exactly once", async () => {
  analyzeCalls = [];
  const rows: Row[] = [];
  await persistListing(fakeDb(rows) as never, "filter-1", listing("new-1"), true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(analyzeCalls.length, 1);
  assert.equal(analyzeCalls[0]?.description, "Opis oferty");
});

test("re-scanning the exact same, unchanged listing a second time does NOT trigger the AI analyzer again", async () => {
  analyzeCalls = [];
  const rows: Row[] = [];
  const item = listing("unchanged-1");
  await persistListing(fakeDb(rows) as never, "filter-1", item, true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
  assert.equal(analyzeCalls.length, 1, "the first (creation) call");
  // Second scan of the SAME unchanged listing, now against the row the
  // first call created.
  await persistListing(fakeDb(rows) as never, "filter-1", item, true, [], "scan-2", "2026-10-04T10:05:00Z", AbortSignal.timeout(1000));
  assert.equal(analyzeCalls.length, 1, "an unchanged re-scan must not call the analyzer a second time");
});

test("a changed listing (different content_hash) triggers the AI analyzer again", async () => {
  analyzeCalls = [];
  const rows: Row[] = [];
  const db = fakeDb(rows);
  await persistListing(db as never, "filter-1", listing("changed-1", { contentHash: "hash-v1" }), true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
  await persistListing(db as never, "filter-1", listing("changed-1", { contentHash: "hash-v2", price: 410_000 }), true, [], "scan-2", "2026-10-04T10:05:00Z", AbortSignal.timeout(1000));
  assert.equal(analyzeCalls.length, 2, "a genuinely changed listing must be re-analyzed");
});

test("a failing AI analyzer call never propagates out of persistListing -- the listing is still saved", async () => {
  analyzeCalls = [];
  analyzeShouldThrow = true;
  try {
    const rows: Row[] = [];
    const result = await persistListing(fakeDb(rows) as never, "filter-1", listing("fails-1"), true, [], "scan-1", "2026-10-04T10:00:00Z", AbortSignal.timeout(1000));
    assert.ok(result.listingId, "the listing itself must still be saved even though the AI analyzer rejected");
  } finally {
    analyzeShouldThrow = false;
  }
});
