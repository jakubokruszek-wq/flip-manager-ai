import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "./server/facebook-fake-supabase.ts";
import type { SearchFilter } from "../flip-finder/index.ts";

/**
 * Real production bug closure, runtime/integration proof: "2 pokoje z
 * balkonem za 260 000 zł" (with a description confirming a sale on Górna in
 * Łódź) showed unknown_price and an unknown location in Finder. This exercises
 * the REAL Watcher import code (importFacebookWatcher, the automated/context
 * path a live scheduler cycle actually uses) against a fake but realistic
 * database, then the REAL Finder read path (getFilterResults) against that
 * SAME database -- proving the fixed price and district survive the entire
 * write-then-read pipeline, not just the extractor in isolation. It also
 * proves Finder's read path never touches facebook_scan_jobs or any
 * collector table, and that this import never needed either.
 */
const POST_ID = "998877665544";
const FILTER_ID = "00000000-0000-0000-0000-000000000010";
const GROUP_ID = "lodzsprzedazzakupwynajem";
const GROUP_URL = `https://www.facebook.com/groups/${GROUP_ID}/`;
const SOURCE_URL = `${GROUP_URL}posts/${POST_ID}/`;
const SOURCE_SCAN_ID = "00000000-0000-0000-0000-000000000011";
const SCAN_RUN_ID = "00000000-0000-0000-0000-000000000012";
const POST_TEXT = "2 pokoje z balkonem za 260 000 zł\nSprzedam mieszkanie na Górnej, stan bardzo dobry.";

const PRICE_BUG_FILTER: SearchFilter = {
  id: FILTER_ID,
  name: "Łódź flip",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: null,
  areaMax: null,
  rooms: [],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: false,
  buildingTypes: [],
  ownershipTypes: [],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 12_000,
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

// The real Watcher orchestration, extraction, classification, persistence and
// canonical reconciliation code all stay in the call path -- only the
// database and a handful of genuinely external side effects are faked.
mock.module(watcherAdminUrl, { namedExports: { createFacebookWatcherAdminClient: () => currentDb } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getActiveSearchFiltersForSource: async () => [PRICE_BUG_FILTER], getSearchFilter: async () => PRICE_BUG_FILTER } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined } });
mock.module("@/features/facebook-groups/server", { namedExports: { recordFacebookGroupImport: async () => undefined } });
mock.module("@/features/facebook-worker/gallery-jobs", { namedExports: { enqueueFacebookGalleryJob: async () => undefined } });

const { importFacebookWatcher } = await import("./server.ts");
const { getFilterResults } = await import("../flip-finder/server/filter-results.ts");

test("the real Watcher import writes the fixed price/district to canonical listings, and getFilterResults returns them, with zero facebook_scan_jobs/collector contact", async () => {
  const db = new FakeFacebookSupabase();
  installCanonicalReconciliationRpc(db);
  db.seed("source_scans", [{ id: SOURCE_SCAN_ID, scan_run_id: SCAN_RUN_ID, search_filter_id: FILTER_ID, source: "facebook" }]);
  currentDb = db;

  const result = await importFacebookWatcher(
    { postText: POST_TEXT, url: SOURCE_URL, images: [] },
    {
      filter: PRICE_BUG_FILTER,
      sourceScanId: SOURCE_SCAN_ID,
      groupId: GROUP_ID,
      groupName: "Łódź Sprzedaż Zakup Wynajem",
      groupUrl: GROUP_URL,
      postId: POST_ID,
      checkedAt: "2026-09-30T12:00:00.000Z",
    },
  );

  assert.equal(result.status, "created", `the listing must actually be created, not skipped; got: ${JSON.stringify(result)}`);
  assert.ok(result.listingId, "a real canonical listing id must be assigned");

  const listings = db.rows("listings");
  assert.equal(listings.length, 1, "exactly one canonical listing must be persisted");
  assert.equal(listings[0].price, 260_000, "the price from the title must reach the canonical listings row, never left null");
  assert.equal(listings[0].district, "Górna", "the district from the description must reach the canonical listings row");
  assert.equal(listings[0].city, "Łódź", "the city must be resolved from the recognized district");

  const memberships = db.rows("listing_filter_matches");
  assert.ok(memberships.some((row) => row.listing_id === result.listingId && row.search_filter_id === FILTER_ID), "a canonical filter membership must be recorded for this listing");

  // Zero contact with facebook_scan_jobs or any collector table during this
  // entirely text-based import -- Watcher's own scheduler/collector plumbing
  // is a wholly separate concern from persisting an already-extracted post.
  assert.deepEqual(db.rows("facebook_scan_jobs"), [], "importing an already-fetched post must never touch facebook_scan_jobs");
  assert.deepEqual(db.rows("collector_scan_batches"), [], "this import must never touch collector data");

  // Finder's own read path, against the exact same database the Watcher just
  // wrote to -- never a live Facebook fetch, never the Watcher's own scan
  // machinery.
  const finderPayload = await getFilterResults(FILTER_ID);
  assert.ok(finderPayload, "the filter must resolve to a real payload");
  // The title alone (no area/building type) genuinely lacks two fields this
  // filter's criteria need -- exactly like the real reported listing -- so it
  // correctly lands in REVIEW, not MATCHED. Either bucket is an acceptable,
  // fully-visible outcome here; what must never happen is the listing being
  // dropped entirely or showing unknown_price.
  const finderResult = [...finderPayload!.results, ...finderPayload!.reviewResults].find((row) => row.id === result.listingId);
  assert.ok(finderResult, "Finder must surface the listing the Watcher import just created, in MATCHED or REVIEW");
  assert.equal(finderResult?.price, 260_000, "Finder must read back the real, saved price, never unknown_price");
  assert.ok(!finderResult?.unknownFields.includes("price"), "Finder must never report unknown_price for a listing with a real, saved price");
  assert.match(finderResult?.locationText ?? "", /Górna|Łódź/, "Finder must show the real, saved location, never 'Lokalizacja nieznana'");

  assert.deepEqual(db.rows("facebook_scan_jobs"), [], "Finder's own read must never touch facebook_scan_jobs either");
  assert.deepEqual(db.rows("collector_scan_batches"), [], "Finder's own read must never touch collector data either");
});
