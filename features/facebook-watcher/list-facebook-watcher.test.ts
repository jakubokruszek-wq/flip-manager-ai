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
  content_hash: null,
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

test("Watcher collapses exact Facebook content duplicates from different post routes", async () => {
  const sourcePostUrl = (group: string, id: string) => `https://www.facebook.com/groups/${group}/posts/${id}`;
  rows = [
    { source_post_url: sourcePostUrl("group-a", "280000000000001"), group_name: "A", published_at: null, collected_at: "2026-09-27T12:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: { ...listing("one", 280_000), external_listing_id: "280000000000001", content_hash: "same-content" } },
    { source_post_url: sourcePostUrl("group-b", "280000000000002"), group_name: "B", published_at: null, collected_at: "2026-09-27T11:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: { ...listing("two", 280_000), external_listing_id: "280000000000002", content_hash: "same-content" } },
    { source_post_url: sourcePostUrl("group-c", "280000000000003"), group_name: "C", published_at: null, collected_at: "2026-09-27T10:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: { ...listing("three", 280_000), external_listing_id: "280000000000003", content_hash: "different-content" } },
  ];
  const result = await listFacebookWatcher();
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.listingId), ["one", "three"]);
});

test("the reported 280k, 550k, 599k and 499k duplicates each render once", async () => {
  const examples = [
    ["280000", 280_000, 59.9],
    ["550000", 550_000, 55],
    ["599000", 599_000, 47.73],
    ["499000", 499_000, 50.5],
  ] as const;
  rows = examples.flatMap(([key, price, area], index) => [1, 2].map((copy) => ({
    source_post_url: `https://www.facebook.com/groups/group-${index}/posts/${key}0000000000${copy}`,
    group_name: `G${index}`,
    published_at: null,
    collected_at: `2026-09-27T${String(12 - index).padStart(2, "0")}:${copy}0:00.000Z`,
    metadata: { listingIntent: "SELL_PROPERTY" },
    listings: { ...listing(`${key}-${copy}`, price), area, content_hash: `fingerprint-${key}` },
  })));
  const result = await listFacebookWatcher();
  assert.equal(result.length, examples.length);
  assert.deepEqual(new Set(result.map((item) => item.price)), new Set(examples.map(([, price]) => price)));
});

test("multiple metadata rows for one listing prefer a valid URL before recency", async () => {
  const sharedListing = { ...listing("metadata-choice", 439_000), content_hash: "metadata-choice" };
  rows = [
    { source_post_url: "https://www.facebook.com/flip-manager/manual/placeholder", group_name: "Test", published_at: null, collected_at: "2026-09-27T12:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: sharedListing },
    { source_post_url: "https://www.facebook.com/groups/test/posts/4486483384955652", group_name: "Test", published_at: null, collected_at: "2026-09-27T11:00:00.000Z", metadata: { listingIntent: "SELL_PROPERTY" }, listings: sharedListing },
  ];
  const result = await listFacebookWatcher();
  assert.equal(result.length, 1);
  assert.equal(result[0]?.sourcePostUrl, "https://www.facebook.com/groups/test/posts/4486483384955652");
});
