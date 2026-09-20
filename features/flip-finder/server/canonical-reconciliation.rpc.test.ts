import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { evaluateCanonicalListingDecision } from "../filter-evaluation.ts";
import type { SearchFilter } from "../index.ts";

/**
 * Real, database-level regression coverage for reconcile_canonical_listing_decision().
 * Runs the ACTUAL migration SQL against a real (embedded, WASM) Postgres engine —
 * not a JS reimplementation of its contract — so this suite would have caught the
 * 42702 "column reference is ambiguous" production bug the FACEBOOK CANONICAL
 * RECONCILIATION 42702 mission fixed, and catches any future reintroduction of it.
 */
const MIGRATION_PATH = path.join(process.cwd(), "supabase/migrations/20260920180000_fix_canonical_reconciliation_ambiguous_column.sql");

function extractFunctionSql(): string {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
  const start = migrationSql.indexOf("create or replace function public.reconcile_canonical_listing_decision");
  assert.ok(start >= 0, "expected the migration to define reconcile_canonical_listing_decision");
  const afterStart = migrationSql.slice(start);
  const bodyEnd = afterStart.indexOf("$$;") + 3;
  return afterStart.slice(0, bodyEnd);
}

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create table listings (
      id uuid primary key,
      lifecycle_status text,
      archived_at timestamptz,
      review_reason text,
      missing_fields jsonb default '[]'::jsonb,
      status text
    );
    create table search_filters (id uuid primary key, name text);
    create table listing_filter_matches (
      listing_id uuid not null,
      search_filter_id uuid not null,
      last_matched_at timestamptz,
      is_current_match boolean,
      match_reasons jsonb,
      match_origin text,
      source_scan_id uuid,
      primary key (listing_id, search_filter_id)
    );
  `);
  await db.exec(extractFunctionSql());
  return db;
}

async function seed(db: PGlite, listingId: string, filterId: string): Promise<void> {
  await db.query(`insert into listings (id, status) values ($1, 'active')`, [listingId]);
  await db.query(`insert into search_filters (id, name) values ($1, 'f')`, [filterId]);
}

type ReconcileRow = { listing_id: string; search_filter_id: string; bucket: string; lifecycle_status: string; is_current_match: boolean; match_reasons: string[] };

async function reconcile(db: PGlite, args: { listingId: string; filterId: string; bucket: string; reasons: string[]; missingFields: string[]; lifecycleStatus: string; matchOrigin?: string }): Promise<ReconcileRow> {
  const result = await db.query<ReconcileRow>(
    `select * from reconcile_canonical_listing_decision($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [args.listingId, args.filterId, args.bucket, JSON.stringify(args.reasons), JSON.stringify(args.missingFields), args.lifecycleStatus, args.matchOrigin ?? "scan", null, new Date().toISOString()],
  );
  return result.rows[0];
}

async function membershipRows(db: PGlite, listingId: string): Promise<Array<{ search_filter_id: string; is_current_match: boolean }>> {
  const result = await db.query<{ search_filter_id: string; is_current_match: boolean }>(`select search_filter_id, is_current_match from listing_filter_matches where listing_id = $1 order by search_filter_id`, [listingId]);
  return result.rows;
}

const CHORALNA_FILTER: SearchFilter = {
  id: "6ebf3a9c-5418-4ae6-a0bf-1989b6603367",
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

test("A: the exact production 42702 fixture (post 1597789548705855's listing/filter) now reconciles successfully", async () => {
  const db = await freshDb();
  const LISTING_ID = "24aad2a9-86e7-48a8-b3c1-0a470ed466e3";
  const FILTER_ID = "6ebf3a9c-5418-4ae6-a0bf-1989b6603367";
  await seed(db, LISTING_ID, FILTER_ID);
  const row = await reconcile(db, { listingId: LISTING_ID, filterId: FILTER_ID, bucket: "REVIEW", reasons: ["review"], missingFields: ["topFloor"], lifecycleStatus: "REVIEW" });
  assert.equal(row.bucket, "REVIEW");
  assert.equal(row.listing_id, LISTING_ID);
  assert.equal(row.search_filter_id, FILTER_ID);
  assert.equal((await membershipRows(db, LISTING_ID)).length, 1);
});

test("B: Chóralna's real decision payload (REVIEW, missing topFloor/buildingType/ownership) reconciles with the correct outcome, once", async () => {
  const db = await freshDb();
  const listingId = crypto.randomUUID();
  const filterId = CHORALNA_FILTER.id;
  await seed(db, listingId, filterId);
  const row = await reconcile(db, { listingId, filterId, bucket: "REVIEW", reasons: [], missingFields: ["topFloor", "buildingType", "ownership"], lifecycleStatus: "REVIEW", matchOrigin: "collector_import" });
  assert.equal(row.bucket, "REVIEW");
  assert.deepEqual(row.match_reasons.sort(), ["review", "unknown_buildingType", "unknown_ownership", "unknown_topFloor"]);
  const listingRow = await db.query<{ lifecycle_status: string; missing_fields: string[] }>(`select lifecycle_status, missing_fields from listings where id = $1`, [listingId]);
  assert.equal(listingRow.rows[0].lifecycle_status, "REVIEW");
  assert.deepEqual(listingRow.rows[0].missing_fields, ["topFloor", "buildingType", "ownership"]);
  const memberships = await membershipRows(db, listingId);
  assert.equal(memberships.length, 1, "exactly one membership row — no duplicate");
});

test("C: post 1595799948904815's real decision payload (REVIEW under incomplete evidence: price/area/topFloor/buildingType/ownership missing)", async () => {
  const db = await freshDb();
  const listingId = crypto.randomUUID();
  const filterId = CHORALNA_FILTER.id;
  await seed(db, listingId, filterId);
  const row = await reconcile(db, { listingId, filterId, bucket: "REVIEW", reasons: [], missingFields: ["price", "area", "topFloor", "buildingType", "ownership"], lifecycleStatus: "REVIEW", matchOrigin: "collector_import" });
  assert.equal(row.bucket, "REVIEW");
  assert.deepEqual(row.match_reasons.sort(), ["review", "unknown_area", "unknown_buildingType", "unknown_ownership", "unknown_price", "unknown_topFloor"]);
});

test("D: a high price/m2 apartment is correctly rejected by the real filter-evaluation logic, and the RPC persists REJECTED without a reconciliation failure", async () => {
  const decision = evaluateCanonicalListingDecision(
    { price: 500_000, area: 40, pricePerSqm: 12_500, rooms: 2, floor: "3", city: "Łódź", district: "Śródmieście", title: "t", locationText: "t", buildingType: "blok" },
    CHORALNA_FILTER,
  );
  assert.equal(decision.bucket, "REJECTED", "sanity: the real, untouched decision logic must actually reject this fixture");
  assert.ok(decision.reasons.includes("max_price_per_sqm"));

  const db = await freshDb();
  const listingId = crypto.randomUUID();
  await seed(db, listingId, CHORALNA_FILTER.id);
  const row = await reconcile(db, { listingId, filterId: CHORALNA_FILTER.id, bucket: decision.bucket, reasons: decision.reasons, missingFields: decision.missingFields, lifecycleStatus: decision.bucket, matchOrigin: "collector_import" });
  assert.equal(row.bucket, "REJECTED");
  assert.equal(row.is_current_match, false);
  const listingRow = await db.query<{ lifecycle_status: string }>(`select lifecycle_status from listings where id = $1`, [listingId]);
  assert.equal(listingRow.rows[0].lifecycle_status, "REJECTED");
});

test("E: an oversize apartment is correctly rejected by the real filter-evaluation logic, and the RPC persists REJECTED without a reconciliation failure", async () => {
  const decision = evaluateCanonicalListingDecision(
    { price: 300_000, area: 90, pricePerSqm: 3_333, rooms: 4, floor: "2", city: "Łódź", district: "Śródmieście", title: "t", locationText: "t", buildingType: "blok" },
    CHORALNA_FILTER,
  );
  assert.equal(decision.bucket, "REJECTED", "sanity: the real, untouched decision logic must actually reject this fixture");
  assert.ok(decision.reasons.includes("area_max"));

  const db = await freshDb();
  const listingId = crypto.randomUUID();
  await seed(db, listingId, CHORALNA_FILTER.id);
  const row = await reconcile(db, { listingId, filterId: CHORALNA_FILTER.id, bucket: decision.bucket, reasons: decision.reasons, missingFields: decision.missingFields, lifecycleStatus: decision.bucket, matchOrigin: "collector_import" });
  assert.equal(row.bucket, "REJECTED");
});

test("F: an already-healthy MATCHED listing is idempotent on retry — no drift, no duplicate membership", async () => {
  const db = await freshDb();
  const listingId = crypto.randomUUID();
  const filterId = CHORALNA_FILTER.id;
  await seed(db, listingId, filterId);
  const first = await reconcile(db, { listingId, filterId, bucket: "MATCHED", reasons: [], missingFields: [], lifecycleStatus: "MATCHED" });
  const second = await reconcile(db, { listingId, filterId, bucket: "MATCHED", reasons: [], missingFields: [], lifecycleStatus: "MATCHED" });
  assert.deepEqual(first, second);
  assert.equal((await membershipRows(db, listingId)).length, 1);
});

test("every bucket (MATCHED/REVIEW/REJECTED) reconciles without 42702, and each maintains independent per-filter membership for the same listing", async () => {
  const db = await freshDb();
  const listingId = crypto.randomUUID();
  const filterA = crypto.randomUUID();
  const filterB = crypto.randomUUID();
  await seed(db, listingId, filterA);
  await db.query(`insert into search_filters (id, name) values ($1, 'f2')`, [filterB]);

  await reconcile(db, { listingId, filterId: filterA, bucket: "MATCHED", reasons: [], missingFields: [], lifecycleStatus: "MATCHED" });
  await reconcile(db, { listingId, filterId: filterB, bucket: "REVIEW", reasons: [], missingFields: ["ownership"], lifecycleStatus: "REVIEW" });

  const memberships = await membershipRows(db, listingId);
  assert.equal(memberships.length, 2, "two distinct filters produce two independent membership rows for the same listing");
  assert.deepEqual(memberships.map((m) => m.search_filter_id).sort(), [filterA, filterB].sort());
});

test("a nonexistent listing still raises the pre-existing CANONICAL_LISTING_NOT_FOUND guard, unaffected by the ambiguity fix", async () => {
  const db = await freshDb();
  await db.query(`insert into search_filters (id, name) values ($1, 'f')`, [CHORALNA_FILTER.id]);
  await assert.rejects(
    reconcile(db, { listingId: crypto.randomUUID(), filterId: CHORALNA_FILTER.id, bucket: "MATCHED", reasons: [], missingFields: [], lifecycleStatus: "MATCHED" }),
    /CANONICAL_LISTING_NOT_FOUND/,
  );
});
