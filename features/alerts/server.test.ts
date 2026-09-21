import assert from "node:assert/strict";
import test, { mock } from "node:test";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FakeFacebookSupabase } from "../facebook-watcher/server/facebook-fake-supabase.ts";

// Hotfix scope B/C: an alert row is never deleted or edited once its
// listing's canonical state later changes — persistOrOverlay only ever
// inserts/upserts (features/alerts/server.ts). Without a current-state
// recheck, an alert generated while a listing was ACTIVE/REVIEW would stay
// visible, unread and pushable forever, even after the listing is later
// REJECTED/STALE/ARCHIVED. These tests drive the REAL getAlerts() end to
// end (not a reimplementation of its filter) against a fake DB so both of
// its consumers — /api/alerts and sendPendingAlertPush (which calls
// getAlerts() itself) — are proven to inherit the same one-query recheck.

let currentDb = new FakeFacebookSupabase();
let listingsQueryCount = 0;

function countingDb(db: FakeFacebookSupabase): FakeFacebookSupabase {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "from") {
        return (table: string) => {
          if (table === "listings") listingsQueryCount += 1;
          return (target as unknown as { from: (t: string) => unknown }).from(table);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as FakeFacebookSupabase;
}

const adminUrl = pathToFileURL(path.resolve(import.meta.dirname, "../facebook-watcher/supabase-admin.ts")).href;
const groupsServerUrl = pathToFileURL(path.resolve(import.meta.dirname, "../facebook-groups/server.ts")).href;
mock.module(adminUrl, { namedExports: { createFacebookWatcherAdminClient: () => countingDb(currentDb) } });
mock.module(groupsServerUrl, { namedExports: { listWatchedFacebookGroups: async () => [] } });

// Static imports of this module (or anything that transitively imports it)
// would fully evaluate against the REAL admin client / groups server before
// the mocks above ever ran — see run-after-response.test.ts for the same
// TDZ pitfall. One dynamic import after every mock.module() call avoids it.
const { getAlerts } = await import("./server.ts");

function baseListing(overrides: Record<string, unknown> = {}) {
  return {
    id: "listing-1", title: "Oferta", description: null, source: "facebook",
    price: 300000, area: 50, price_per_sqm: 6000, city: "Łódź", district: null,
    original_url: null, flip_score: 40, created_at: "2026-09-19T00:00:00Z",
    first_seen_at: "2026-09-19T00:00:00Z", status: "active",
    lifecycle_status: "ACTIVE", manual_decision: null,
    ...overrides,
  };
}

function historicalAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "alert-1", event_key: "listing-1:new_listing:v1", type: "new_listing",
    listing_id: "listing-1", title: "Oferta", source: "facebook", seller_type: null,
    price: 300000, area: 50, neighborhood: null, city: "Łódź", price_per_sqm: 6000,
    flip_score: 40, opportunity_score: null, condition: null, group_name: null,
    flags: [], detected_at: "2026-09-19T00:00:00Z", read_at: null,
    details_url: "/facebook-watcher?listing=listing-1", original_url: null,
    ...overrides,
  };
}

// persistOrOverlay (features/alerts/server.ts) short-circuits to [] without
// ever reading the alerts table at all when nothing is freshly generated
// this call — harmless in production (500 active listings essentially never
// generate zero alerts: every ACTIVE one alone regenerates canonical_match
// on every call), but a single REJECTED/STALE/ARCHIVED test listing alone
// generates nothing. An always-ACTIVE anchor listing in every scenario below
// guarantees generation is non-empty, so persistOrOverlay actually reaches
// its real upsert+read path and the historical alert under test is genuinely
// exercised through it — not trivially "hidden" by an empty early return.
function anchorListing() {
  return baseListing({ id: "anchor-active", lifecycle_status: "ACTIVE" });
}

function reset(): void {
  currentDb = new FakeFacebookSupabase();
  currentDb.seed("listing_source_metadata", []);
  currentDb.seed("listing_snapshots", []);
  listingsQueryCount = 0;
}

test("control: an alert whose listing is currently ACTIVE stays visible", async () => {
  reset();
  currentDb.seed("listings", [anchorListing(), baseListing({ id: "l-active", lifecycle_status: "ACTIVE" })]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-active:new_listing:v1", listing_id: "l-active" })]);
  const alerts = await getAlerts();
  assert.ok(alerts.some((a) => a.eventKey === "l-active:new_listing:v1"));
});

test("control: an alert whose listing is currently REVIEW stays visible", async () => {
  reset();
  currentDb.seed("listings", [anchorListing(), baseListing({ id: "l-review", lifecycle_status: "REVIEW" })]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-review:new_listing:v1", listing_id: "l-review" })]);
  const alerts = await getAlerts();
  assert.ok(alerts.some((a) => a.eventKey === "l-review:new_listing:v1"));
});

test("a historical alert whose listing is now lifecycle_status=REJECTED is hidden, but its row is kept in the database", async () => {
  reset();
  currentDb.seed("listings", [anchorListing(), baseListing({ id: "l-rejected", lifecycle_status: "REJECTED" })]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-rejected:new_listing:v1", listing_id: "l-rejected" })]);
  const alerts = await getAlerts();
  assert.equal(alerts.some((a) => a.eventKey === "l-rejected:new_listing:v1"), false, "must not be visible");
  assert.ok(currentDb.rows("alerts").some((row) => row.event_key === "l-rejected:new_listing:v1"), "row must still exist in the database — never deleted");
});

test("a historical alert whose listing now has manual_decision=REJECTED is hidden", async () => {
  reset();
  currentDb.seed("listings", [anchorListing(), baseListing({ id: "l-manual-rejected", lifecycle_status: "ACTIVE", manual_decision: "REJECTED" })]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-manual-rejected:new_listing:v1", listing_id: "l-manual-rejected" })]);
  const alerts = await getAlerts();
  assert.equal(alerts.some((a) => a.eventKey === "l-manual-rejected:new_listing:v1"), false);
});

test("a historical alert whose listing is now STALE is hidden", async () => {
  reset();
  currentDb.seed("listings", [anchorListing(), baseListing({ id: "l-stale", lifecycle_status: "STALE" })]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-stale:new_listing:v1", listing_id: "l-stale" })]);
  const alerts = await getAlerts();
  assert.equal(alerts.some((a) => a.eventKey === "l-stale:new_listing:v1"), false);
});

test("a historical alert whose listing is now ARCHIVED is hidden", async () => {
  reset();
  currentDb.seed("listings", [anchorListing(), baseListing({ id: "l-archived", lifecycle_status: "ARCHIVED" })]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-archived:new_listing:v1", listing_id: "l-archived" })]);
  const alerts = await getAlerts();
  assert.equal(alerts.some((a) => a.eventKey === "l-archived:new_listing:v1"), false);
});

test("fail-closed: an alert whose listing no longer exists at all is hidden, never guessed as actionable", async () => {
  reset();
  currentDb.seed("listings", [anchorListing()]);
  currentDb.seed("alerts", [historicalAlert({ id: "a1", event_key: "l-missing:new_listing:v1", listing_id: "l-missing" })]);
  const alerts = await getAlerts();
  assert.equal(alerts.some((a) => a.eventKey === "l-missing:new_listing:v1"), false);
});

test("the current-state recheck is exactly one bounded query regardless of how many alerts/listings are being checked", async () => {
  reset();
  const listings = Array.from({ length: 6 }, (_, i) => baseListing({ id: `l-${i}`, lifecycle_status: i % 2 === 0 ? "ACTIVE" : "REJECTED" }));
  const alerts = listings.map((listing, i) => historicalAlert({ id: `a-${i}`, event_key: `l-${i}:new_listing:v1`, listing_id: listing.id }));
  currentDb.seed("listings", listings);
  currentDb.seed("alerts", alerts);
  const result = await getAlerts();
  const eventKeys = new Set(result.map((a) => a.eventKey));
  // ACTIVE listings (l-0, l-2, l-4) additionally regenerate their own fresh
  // canonical_match alert on every call — that is unrelated to this test's
  // concern, so it asserts on the specific historical new_listing event keys
  // rather than a total count.
  for (const i of [0, 2, 4]) assert.ok(eventKeys.has(`l-${i}:new_listing:v1`), `l-${i} is ACTIVE, its historical alert must remain visible`);
  for (const i of [1, 3, 5]) assert.equal(eventKeys.has(`l-${i}:new_listing:v1`), false, `l-${i} is REJECTED, its historical alert must be hidden`);
  // getAlerts() itself queries "listings" once (to generate fresh alerts from
  // active listings) plus exactly one more time for the recheck — never once
  // per alert, regardless of the 6 distinct listings involved here.
  assert.equal(listingsQueryCount, 2, "the recheck must not be N+1");
});

test("persistOrOverlay keeps an existing alert unchanged when the same event_key is regenerated", async () => {
  reset();
  const listing = anchorListing();
  const eventKey = `${listing.id}:canonical_match:v1`;
  const original = historicalAlert({
    id: "original-alert",
    event_key: eventKey,
    listing_id: listing.id,
    type: "canonical_match",
    title: "Original persisted title",
    read_at: "2026-09-20T12:00:00Z",
    push_delivered_at: "2026-09-20T12:01:00Z",
  });
  currentDb.seed("listings", [listing]);
  currentDb.seed("alerts", [original]);
  const before = JSON.stringify(currentDb.rows("alerts"));

  await getAlerts();

  assert.equal(JSON.stringify(currentDb.rows("alerts")), before, "a regenerated duplicate must not overwrite the historical alert row");
});
