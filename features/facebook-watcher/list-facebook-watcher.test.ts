import assert from "node:assert/strict";
import test, { mock } from "node:test";

type Row = Record<string, unknown>;

const filters: never[] = [];
let rows: Row[] = [];

class Query {
  select() { return this; }
  eq() { return this; }
  order() { return this; }
  limit() { return Promise.resolve({ data: rows, error: null }); }
}

const adminClient = { from: () => new Query() };

mock.module("./supabase-admin", { namedExports: { createFacebookWatcherAdminClient: () => adminClient } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getActiveSearchFiltersForSource: async () => filters } });

const { listFacebookWatcher } = await import("./server.ts");

const listing = (id: string, price: number) => ({
  id,
  external_listing_id: `post-${id}`,
  title: "Mieszkanie na sprzedaż",
  price,
  price_per_sqm: price / 50,
  area: 50,
  rooms: 2,
  floor: "2",
  district: "Bałuty",
  city: "Łódź",
  address: null,
  description: "Oferta testowa",
  original_url: null,
  images: [],
  status: "active",
  source: "facebook",
  flip_score: 50,
  estimated_profit: null,
  first_seen_at: "2026-09-27T10:00:00.000Z",
  last_seen_at: "2026-09-27T10:00:00.000Z",
  created_at: "2026-09-27T10:00:00.000Z",
  building_type: "blok",
  ownership: "pełna własność",
  lifecycle_status: "ACTIVE",
  archived_at: null,
});

test("Watcher list hides a below-minimum sale and keeps a valid sale once", async () => {
  const sourcePostUrl = (id: string) => `https://www.facebook.com/groups/test/posts/${id}`;
  rows = [
    { source_post_url: sourcePostUrl("cheap"), group_name: "Test", published_at: null, collected_at: "2026-09-27T12:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: listing("cheap", 15_000) },
    { source_post_url: sourcePostUrl("valid"), group_name: "Test", published_at: null, collected_at: "2026-09-27T11:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: listing("valid", 439_000) },
  ];

  const result = await listFacebookWatcher();
  assert.deepEqual(result.map((item) => item.listingId), ["valid"]);
  assert.equal(result[0]?.price, 439_000);
});
