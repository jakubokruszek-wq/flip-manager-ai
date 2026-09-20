import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { FakeFacebookSupabase, installCanonicalReconciliationRpc } from "./server/facebook-fake-supabase.ts";
import type { SearchFilter } from "../flip-finder/index.ts";

const POST_ID = "1597595792058564";
const LISTING_ID = "00000000-0000-0000-0000-000000000001";
const FILTER_ID = "00000000-0000-0000-0000-000000000002";
const SOURCE_SCAN_ID = "00000000-0000-0000-0000-000000000003";
const SCAN_RUN_ID = "00000000-0000-0000-0000-000000000004";
const SOURCE_URL = `https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/${POST_ID}/`;
const CHORALNA_TEXT = "2-pokojowe mieszkanie do remontu na sprzedaż - ul Chóralna, piętro 11, duży balkon, 47 m2\n295 tys 🔥\n📞795 016 049";

const CHORALNA_FILTER: SearchFilter = {
  id: FILTER_ID,
  name: "Łódź flip",
  sources: ["facebook"],
  city: "Łódź",
  districts: [],
  priceMin: null,
  priceMax: null,
  areaMin: 32,
  areaMax: 58,
  rooms: [1, 2, 3, 4],
  floorMin: null,
  floorMax: null,
  excludeGroundFloor: false,
  excludeTopFloor: true,
  buildingTypes: ["blok", "apartamentowiec"],
  ownershipTypes: ["pełna własność", "spółdzielcze"],
  marketType: null,
  privateOnly: false,
  maxPricePerSqm: 7000,
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
const adminUrl = pathToFileURL(path.resolve(import.meta.dirname, "supabase-admin.ts")).href;

// These mocks keep the integration test local while leaving the real watcher
// orchestration, extraction, persistence, and canonical reconciliation code in
// the call path.
mock.module(adminUrl, { namedExports: { createFacebookWatcherAdminClient: () => currentDb } });
mock.module("@/features/flip-finder/server/search-filters", { namedExports: { getActiveSearchFiltersForSource: async () => [CHORALNA_FILTER] } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
mock.module("@/features/market-intelligence/resale-comps-store", { namedExports: { syncResaleCompFromListing: async () => undefined } });
mock.module("@/features/facebook-groups/server", { namedExports: { recordFacebookGroupImport: async () => undefined } });
mock.module("@/features/facebook-worker/gallery-jobs", { namedExports: { enqueueFacebookGalleryJob: async () => undefined } });

const { repairFacebookOrphanFromCollectorEvidence } = await import("./server.ts");

function freshDatabase(): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  installCanonicalReconciliationRpc(db);
  db.seed("listings", [{
    id: LISTING_ID,
    source: "facebook",
    external_listing_id: POST_ID,
    original_url: SOURCE_URL,
    normalized_url: SOURCE_URL,
    title: "Chóralna",
    price: 295000,
    area: 47,
    rooms: 2,
    floor: 11,
    city: "Łódź",
    status: "active",
    lifecycle_status: "REVIEW",
    content_hash: null,
    images: [],
  }]);
  db.seed("collector_scan_batches", [{
    id: "batch-1",
    scan_id: SCAN_RUN_ID,
    source_type: "GROUP",
    source_id: "lodzsprzedazzakupwynajem",
    source_url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/",
    received_at: "2026-09-20T14:30:00.000Z",
    payload: {
      posts: [{
        postId: POST_ID,
        permalink: SOURCE_URL,
        text: CHORALNA_TEXT,
        author: "Maja Piotrowska",
        publishedAt: "2026-09-20T14:29:39.000Z",
        media: [],
        discoverySource: "MAIN_FEED",
        foundInMainFeed: true,
        firstSeenPhase: "MAIN_FEED",
      }],
    },
  }]);
  db.seed("source_scans", [{ id: SOURCE_SCAN_ID, scan_run_id: SCAN_RUN_ID, search_filter_id: FILTER_ID, source: "facebook" }]);
  return db;
}

async function recover(db: FakeFacebookSupabase): Promise<void> {
  currentDb = db;
  await repairFacebookOrphanFromCollectorEvidence(LISTING_ID);
}

function assertRecovered(db: FakeFacebookSupabase): void {
  const listings = db.rows("listings");
  const metadata = db.rows("listing_source_metadata");
  const memberships = db.rows("listing_filter_matches");
  assert.equal(listings.length, 1, "recovery must reuse the orphan listing");
  assert.equal(listings[0].id, LISTING_ID);
  assert.equal(metadata.length, 1, "metadata is repaired exactly once");
  assert.equal(metadata[0].listing_id, LISTING_ID);
  assert.equal(memberships.length, 1, "canonical membership is repaired exactly once");
  assert.equal(memberships[0].listing_id, LISTING_ID);
  assert.equal(memberships[0].search_filter_id, FILTER_ID);
  assert.equal(listings[0].lifecycle_status, "REVIEW", "unknown Chóralna fields remain REVIEW");
  assert.deepEqual(listings[0].missing_fields, ["topFloor", "buildingType", "ownership"]);
}

test("Chóralna recovery is idempotent and preserves Finder/Watcher visibility", async () => {
  const db = freshDatabase();
  await recover(db);
  assertRecovered(db);
  await recover(db);
  assertRecovered(db);
  assert.equal(db.rows("listing_filter_matches").filter((row) => row.listing_id === LISTING_ID).length, 1);
});

test("CASE 1: persisted listing plus metadata failure is incomplete, then retry repairs metadata and membership", async () => {
  const db = freshDatabase().failNext("listing_source_metadata", "upsert", "metadata unavailable");
  await assert.rejects(recover(db), /FACEBOOK_METADATA_PERSIST_FAILED|metadata unavailable/);
  assert.equal(db.rows("listings").length, 1);
  assert.equal(db.rows("listing_source_metadata").length, 0);
  await recover(db);
  assertRecovered(db);
});

test("CASE 2: metadata is present but reconciliation read-back fails, then retry repairs membership", async () => {
  const db = freshDatabase().failNext("listing_filter_matches", "select", "reconciliation read-back unavailable");
  await assert.rejects(recover(db), /FACEBOOK_FILTER_RECONCILE_FAILED|reconciliation read-back unavailable/);
  assert.equal(db.rows("listings").length, 1);
  assert.equal(db.rows("listing_source_metadata").length, 1, "metadata remains durable after the read-back failure");
  assert.equal(db.rows("listing_filter_matches").length, 1, "canonical RPC already wrote the membership atomically");
  await recover(db);
  assertRecovered(db);
});

test("canonical RPC failure is resumable and the next retry self-heals without duplicating the listing", async () => {
  const db = freshDatabase().failNextRpc("reconcile_canonical_listing_decision", "rpc unavailable");
  await assert.rejects(recover(db), /FACEBOOK_FILTER_RECONCILE_FAILED|rpc unavailable/);
  assert.equal(db.rows("listings").length, 1);
  assert.equal(db.rows("listing_source_metadata").length, 0);
  await recover(db);
  assertRecovered(db);
});

test("arbitrary listing ids and unrelated collector posts cannot drive a repair", async () => {
  const db = freshDatabase();
  db.seed("collector_scan_batches", [{
    scan_id: SCAN_RUN_ID,
    source_type: "GROUP",
    source_id: "lodzsprzedazzakupwynajem",
    source_url: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/",
    received_at: "2026-09-20T14:30:00.000Z",
    payload: { posts: [{ postId: "999999999999999", permalink: "https://www.facebook.com/groups/lodzsprzedazzakupwynajem/posts/999999999999999/", text: CHORALNA_TEXT }] },
  }]);
  await assert.rejects(recover(db), /FACEBOOK_ORPHAN_SOURCE_EVIDENCE_MISSING/);
  assert.equal(db.rows("listings").length, 1);
  assert.equal(db.rows("listing_source_metadata").length, 0);
  assert.equal(db.rows("listing_filter_matches").length, 0);
});

test("a non-Facebook listing cannot be repaired through the Facebook orphan path", async () => {
  const db = freshDatabase();
  db.seed("listings", [{ ...db.rows("listings")[0], source: "olx" }]);
  await assert.rejects(recover(db), /FACEBOOK_ORPHAN_SOURCE_IDENTITY_MISSING/);
  assert.equal(db.rows("listing_source_metadata").length, 0);
  assert.equal(db.rows("listing_filter_matches").length, 0);
});
