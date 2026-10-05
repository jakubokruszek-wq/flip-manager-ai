import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "./server/facebook-fake-supabase.ts";
import type { SearchFilter } from "../flip-finder/index.ts";

/**
 * Full local regression for the reported Żychlin cards.  This deliberately
 * starts with only a filter and a source-scan row: the canonical listing,
 * metadata, membership and Finder result are all produced by the real
 * Watcher import -> persistListing -> canonical reconciliation path.
 */
const FILTER_ID = "00000000-0000-0000-0000-000000000021";
const SOURCE_SCAN_ID = "00000000-0000-0000-0000-000000000022";
const SCAN_RUN_ID = "00000000-0000-0000-0000-000000000023";
const GROUP_ID = "lodzkie-mieszkania";
const GROUP_URL = `https://www.facebook.com/groups/${GROUP_ID}/`;
const POST_TEXT = "SPRZEDAM: Rozkładowe 3 pokoje w Żychlinie, 270 000 zł, 58 m2";
const FILTER: SearchFilter = {
  id: FILTER_ID,
  name: "Żychlin full ingest regression",
  sources: ["facebook"],
  city: "Żychlin",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: 40,
  areaMax: 80,
  rooms: [3],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 20_000,
  requiredKeywords: [],
  excludedKeywords: [],
  minFlipScore: null,
  minEstimatedProfit: null,
  maxEstimatedRenovationCost: null,
  scanIntervalMinutes: 60,
  isActive: true,
  lastScannedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

let currentDb = new FakeFacebookSupabase();
const watcherAdminUrl = pathToFileURL(path.resolve(import.meta.dirname, "supabase-admin.ts")).href;

mock.module(watcherAdminUrl, { namedExports: { createFacebookWatcherAdminClient: () => currentDb } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
mock.module("@/features/flip-finder/server/search-filters", {
  namedExports: {
    getActiveSearchFiltersForSource: async () => [FILTER],
    getSearchFilter: async () => FILTER,
  },
});
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined } });
mock.module("@/features/facebook-groups/server", { namedExports: { recordFacebookGroupImport: async () => undefined } });
mock.module("@/features/facebook-worker/gallery-jobs", { namedExports: { enqueueFacebookGalleryJob: async () => undefined } });

const { importFacebookWatcher } = await import("./server.ts");
const { getFilterResults } = await import("../flip-finder/server/filter-results.ts");

function context(postId: string, checkedAt: string) {
  const sourceUrl = `${GROUP_URL}posts/${postId}/`;
  return {
    input: { postText: POST_TEXT, url: sourceUrl, images: [] },
    context: {
      filter: FILTER,
      sourceScanId: SOURCE_SCAN_ID,
      groupId: GROUP_ID,
      groupName: "Łódzkie mieszkania",
      groupUrl: GROUP_URL,
      postId,
      checkedAt,
    },
  };
}

test("Żychlin follows parser -> real ingest -> canonical listing -> Finder, with stable and distinct Facebook identities", async () => {
  const db = new FakeFacebookSupabase();
  installCanonicalReconciliationRpc(db);
  db.seed("source_scans", [{ id: SOURCE_SCAN_ID, scan_run_id: SCAN_RUN_ID, search_filter_id: FILTER_ID, source: "facebook" }]);
  currentDb = db;

  const first = context("700000000001", "2026-10-05T10:00:00.000Z");
  const firstImport = await importFacebookWatcher(first.input, first.context);
  assert.equal(firstImport.status, "created");
  assert.ok(firstImport.listingId);
  assert.equal(firstImport.extracted.city, "Żychlin", "the authoritative post text must win over the Łódź group context");
  assert.equal(firstImport.extracted.price, 270_000);
  assert.equal(firstImport.extracted.area, 58);
  assert.equal(firstImport.extracted.rooms, 3);

  const listingsAfterFirst = db.rows("listings");
  assert.equal(listingsAfterFirst.length, 1, "the first real ingest creates one canonical listing");
  assert.equal(listingsAfterFirst[0].city, "Żychlin");

  const retry = context("700000000001", "2026-10-05T10:01:00.000Z");
  retry.input.postText = `${POST_TEXT}, aktualizacja ceny i opisu`;
  const retryImport = await importFacebookWatcher(retry.input, retry.context);
  assert.equal(retryImport.status, "updated");
  assert.equal(retryImport.listingId, firstImport.listingId, "the same confirmed Facebook post ID must resolve to the same listings.id");
  assert.equal(db.rows("listings").length, 1, "a retry must not create a second canonical listing");

  const second = context("700000000002", "2026-10-05T10:02:00.000Z");
  const secondImport = await importFacebookWatcher(second.input, second.context);
  assert.equal(secondImport.status, "created");
  assert.ok(secondImport.listingId);
  assert.notEqual(secondImport.listingId, firstImport.listingId, "different confirmed post IDs must remain different listings even with identical content");
  assert.equal(db.rows("listings").length, 2);

  const finderPayload = await getFilterResults(FILTER_ID);
  assert.ok(finderPayload);
  const finderRows = [...finderPayload.results, ...finderPayload.reviewResults];
  assert.equal(finderRows.length, 2, "Finder must expose both canonical offers exactly once");
  assert.deepEqual(new Set(finderRows.map((row) => row.id)), new Set([firstImport.listingId, secondImport.listingId]));
  for (const row of finderRows) {
    assert.match(row.locationText ?? "", /Żychlin/, "Finder must show Żychlin, never the group's Łódź location");
    assert.equal(row.price, 270_000);
    assert.equal(row.area, 58);
  }
  assert.deepEqual(db.rows("facebook_scan_jobs"), [], "the Finder read path and this ingest must not create Facebook jobs");
});
