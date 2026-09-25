import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(import.meta.dirname, "../../..");
const migrationPath = path.join(root, "supabase/migrations/20260924204646_restrict_listing_writes_to_trusted_server.sql");
const migration = fs.readFileSync(migrationPath, "utf8");

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.listings (
      id uuid primary key,
      lifecycle_status text,
      manual_decision text,
      manual_decision_reason text,
      review_reason text,
      missing_fields jsonb not null default '[]'::jsonb,
      archived_at timestamptz,
      status text not null default 'active'
    );
    create table public.search_filters (id uuid primary key);
    create table public.listing_filter_matches (
      listing_id uuid not null,
      search_filter_id uuid not null,
      last_matched_at timestamptz,
      match_reasons jsonb not null default '[]'::jsonb,
      is_current_match boolean not null default false,
      primary key (listing_id, search_filter_id)
    );
    create table public.properties (id uuid primary key);
    grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  `);
  await db.exec(migration);
  return db;
}

const LISTING = "11111111-1111-4111-8111-111111111111";
const FILTER_A = "22222222-2222-4222-8222-222222222222";
const FILTER_B = "33333333-3333-4333-8333-333333333333";

async function seedReview(db: PGlite, membership = true) {
  await db.query(`insert into listings(id,lifecycle_status,manual_decision,review_reason,missing_fields,status) values ($1,'REVIEW',null,'review','["buildingType"]','active')`, [LISTING]);
  if (membership) {
    await db.query(`insert into listing_filter_matches(listing_id,search_filter_id,match_reasons,is_current_match) values ($1,$2,'["review","unknown_buildingType","price_ok"]',false),($1,$3,'["review"]',false)`, [LISTING, FILTER_A, FILTER_B]);
  }
}

async function decide(db: PGlite, decision: "ACCEPTED" | "REJECTED") {
  return db.query<{ listing_id: string; decision: string; lifecycle_status: string; membership_count: number }>(`select * from public.apply_listing_review_decision($1,$2,null,'2026-09-25T00:00:00Z')`, [LISTING, decision]);
}

test("migration denies direct listing writes and keeps service-role writes", async () => {
  const db = await database();
  try {
    const privileges = await db.query<{ anon_insert: boolean; authenticated_update: boolean; anon_delete: boolean; service_insert: boolean; service_update: boolean; service_delete: boolean }>(`
      select
        has_table_privilege('anon','public.listings','INSERT') anon_insert,
        has_table_privilege('authenticated','public.listings','UPDATE') authenticated_update,
        has_table_privilege('anon','public.listings','DELETE') anon_delete,
        has_table_privilege('service_role','public.listings','INSERT') service_insert,
        has_table_privilege('service_role','public.listings','UPDATE') service_update,
        has_table_privilege('service_role','public.listings','DELETE') service_delete
    `);
    assert.deepEqual(privileges.rows[0], { anon_insert: false, authenticated_update: false, anon_delete: false, service_insert: true, service_update: true, service_delete: true });
  } finally { await db.close(); }
});

test("review RPC is service-role-only, invoker security, and fixed search_path", async () => {
  const db = await database();
  try {
    const privileges = await db.query<{ anon_exec: boolean; authenticated_exec: boolean; service_exec: boolean }>(`select has_function_privilege('anon','public.apply_listing_review_decision(uuid,text,text,timestamptz)','EXECUTE') anon_exec, has_function_privilege('authenticated','public.apply_listing_review_decision(uuid,text,text,timestamptz)','EXECUTE') authenticated_exec, has_function_privilege('service_role','public.apply_listing_review_decision(uuid,text,text,timestamptz)','EXECUTE') service_exec`);
    assert.deepEqual(privileges.rows[0], { anon_exec: false, authenticated_exec: false, service_exec: true });
    assert.match(migration, /language plpgsql\s+security invoker\s+set search_path = public/i);
    assert.doesNotMatch(migration, /security definer|execute\s+immediate/i);
  } finally { await db.close(); }
});

test("accept updates listing and all memberships atomically and idempotently", async () => {
  const db = await database();
  try {
    await seedReview(db);
    await db.exec("set role service_role");
    const result = await decide(db, "ACCEPTED");
    assert.equal(result.rows[0].membership_count, 2);
    await decide(db, "ACCEPTED");
    await db.exec("reset role");
    const listing = await db.query<{ lifecycle_status: string; manual_decision: string; review_reason: string | null; missing_fields: unknown[] }>(`select lifecycle_status,manual_decision,review_reason,missing_fields from listings where id=$1`, [LISTING]);
    assert.deepEqual(listing.rows[0], { lifecycle_status: "ACTIVE", manual_decision: "ACCEPTED", review_reason: null, missing_fields: [] });
    const matches = await db.query<{ is_current_match: boolean; match_reasons: string[] }>(`select is_current_match,match_reasons from listing_filter_matches where listing_id=$1 order by search_filter_id`, [LISTING]);
    assert.equal(matches.rows.length, 2);
    assert.ok(matches.rows.every((row) => row.is_current_match));
    assert.deepEqual(matches.rows[0].match_reasons, ["manual_accept", "price_ok"]);
    assert.deepEqual(matches.rows[1].match_reasons, ["manual_accept"]);
  } finally { await db.close(); }
});

test("reject changes the listing and every membership in the same statement", async () => {
  const db = await database();
  try {
    await seedReview(db);
    await db.exec("set role service_role");
    await decide(db, "REJECTED");
    await db.exec("reset role");
    const listing = await db.query<{ lifecycle_status: string; manual_decision: string }>(`select lifecycle_status,manual_decision from listings where id=$1`, [LISTING]);
    assert.deepEqual(listing.rows[0], { lifecycle_status: "REJECTED", manual_decision: "REJECTED" });
    const matches = await db.query<{ is_current_match: boolean }>(`select is_current_match from listing_filter_matches where listing_id=$1`, [LISTING]);
    assert.ok(matches.rows.every((row) => !row.is_current_match));
  } finally { await db.close(); }
});

test("invalid transitions and missing memberships roll back the listing update", async () => {
  const db = await database();
  try {
    await db.query(`insert into listings(id,lifecycle_status,manual_decision,review_reason,missing_fields,status) values ($1,'ACTIVE',null,'keep','["area"]','active')`, [LISTING]);
    await db.query(`insert into listing_filter_matches(listing_id,search_filter_id,match_reasons,is_current_match) values ($1,$2,'[]',true)`, [LISTING, FILTER_A]);
    await db.exec("set role service_role");
    await assert.rejects(decide(db, "REJECTED"), /LISTING_REVIEW_INVALID_TRANSITION/);
    await db.exec("reset role");
    const unchanged = await db.query<{ lifecycle_status: string; manual_decision: string | null }>(`select lifecycle_status,manual_decision from listings where id=$1`, [LISTING]);
    assert.deepEqual(unchanged.rows[0], { lifecycle_status: "ACTIVE", manual_decision: null });

    await db.exec(`delete from listing_filter_matches; delete from listings;`);
    await seedReview(db, false);
    await db.exec("set role service_role");
    await assert.rejects(decide(db, "ACCEPTED"), /LISTING_REVIEW_MEMBERSHIP_MISSING/);
    await db.exec("reset role");
    const rolledBack = await db.query<{ lifecycle_status: string; manual_decision: string | null }>(`select lifecycle_status,manual_decision from listings where id=$1`, [LISTING]);
    assert.deepEqual(rolledBack.rows[0], { lifecycle_status: "REVIEW", manual_decision: null });
  } finally { await db.close(); }
});

test("an injected membership failure rolls back the preceding listing update", async () => {
  const db = await database();
  try {
    await seedReview(db);
    await db.exec(`create function fail_membership_update() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_MEMBERSHIP_FAILURE'; end $$; create trigger fail_membership before update on listing_filter_matches for each row execute function fail_membership_update();`);
    await db.exec("set role service_role");
    await assert.rejects(decide(db, "ACCEPTED"), /INJECTED_MEMBERSHIP_FAILURE/);
    await db.exec("reset role");
    const listing = await db.query<{ lifecycle_status: string; manual_decision: string | null; review_reason: string }>(`select lifecycle_status,manual_decision,review_reason from listings where id=$1`, [LISTING]);
    assert.deepEqual(listing.rows[0], { lifecycle_status: "REVIEW", manual_decision: null, review_reason: "review" });
  } finally { await db.close(); }
});
