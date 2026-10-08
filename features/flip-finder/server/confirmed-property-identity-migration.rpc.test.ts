import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LEGACY_DECISION = path.join(ROOT, "supabase/migrations/20260924204646_restrict_listing_writes_to_trusted_server.sql");
const IDENTITY_MIGRATION = path.join(ROOT, "supabase/migrations/20261008120000_add_confirmed_property_identity.sql");
const LISTING_A = "11111111-1111-4111-8111-111111111111";
const LISTING_B = "22222222-2222-4222-8222-222222222222";
const FILTER = "33333333-3333-4333-8333-333333333333";

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create table public.listings(id uuid primary key, source text, cross_source_identity text, lifecycle_status text, manual_decision text, manual_decision_reason text, review_reason text, missing_fields jsonb not null default '[]'::jsonb, archived_at timestamptz, status text not null default 'active');
    create table public.search_filters(id uuid primary key);
    create table public.listing_filter_matches(listing_id uuid not null, search_filter_id uuid not null, last_matched_at timestamptz, match_reasons jsonb not null default '[]'::jsonb, is_current_match boolean not null default false, primary key(listing_id,search_filter_id));
    create table public.properties(id uuid primary key, cross_source_identity text);
    create table public.price_radar_listings(cross_source_identity text);
    grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
  `);
  await db.exec(fs.readFileSync(LEGACY_DECISION, "utf8"));
  await db.exec(fs.readFileSync(IDENTITY_MIGRATION, "utf8"));
  return db;
}

async function seed(db: PGlite, identity: string | null) {
  await db.query(`insert into public.search_filters(id) values ($1)`, [FILTER]);
  await db.query(`insert into public.listings(id,source,cross_source_identity,lifecycle_status,status) values ($1,'gratka',$3,'ACTIVE','active'),($2,'morizon',$3,'REVIEW','active')`, [LISTING_A, LISTING_B, identity]);
  await db.query(`insert into public.listing_filter_matches(listing_id,search_filter_id,is_current_match,match_reasons) values ($1,$3,true,'["price_ok"]'),($2,$3,false,'["review","unknown_buildingType"]')`, [LISTING_A, LISTING_B, FILTER]);
}

test("identity-group decision migration is invoker/service-role only and unique CRM identity is enforced", async () => {
  const db = await database();
  try {
    const grants = await db.query<{ anon_exec: boolean; authenticated_exec: boolean; service_exec: boolean; anon_property_update: boolean; service_property_update: boolean }>(`
      select has_function_privilege('anon','public.apply_confirmed_property_group_review_decision(uuid,text,text,timestamptz)','EXECUTE') anon_exec,
        has_function_privilege('authenticated','public.apply_confirmed_property_group_review_decision(uuid,text,text,timestamptz)','EXECUTE') authenticated_exec,
        has_function_privilege('service_role','public.apply_confirmed_property_group_review_decision(uuid,text,text,timestamptz)','EXECUTE') service_exec,
        has_table_privilege('anon','public.properties','UPDATE') anon_property_update,
        has_table_privilege('service_role','public.properties','UPDATE') service_property_update`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, authenticated_exec: false, service_exec: true, anon_property_update: false, service_property_update: true });
    const fn = await db.query<{ security_type: string; config: string[] | null }>(`select p.prosecdef::text security_type,p.proconfig config from pg_proc p where p.oid='public.apply_confirmed_property_group_review_decision(uuid,text,text,timestamptz)'::regprocedure`);
    assert.equal(fn.rows[0].security_type, "false", "the wrapper does not elevate privileges");
    assert.ok(fn.rows[0].config?.includes("search_path=public"));
    await db.query(`insert into public.properties(id,cross_source_identity) values ('44444444-4444-4444-8444-444444444444','portal_shared_unit_id:unit-1')`);
    await assert.rejects(db.query(`insert into public.properties(id,cross_source_identity) values ('55555555-5555-4555-8555-555555555555','portal_shared_unit_id:unit-1')`));
  } finally { await db.close(); }
});

test("one ACCEPTED decision updates every confirmed source row and its memberships atomically and idempotently", async () => {
  const db = await database();
  try {
    await seed(db, "canonical_unit_id:unit-1");
    await db.exec("set role service_role");
    const result = await db.query<{ lifecycle_status: string; membership_count: number }>(`select lifecycle_status,membership_count from public.apply_confirmed_property_group_review_decision($1,'ACCEPTED',null,'2026-10-08T12:00:00Z')`, [LISTING_B]);
    assert.deepEqual(result.rows[0], { lifecycle_status: "ACTIVE", membership_count: 2 });
    await db.query(`select * from public.apply_confirmed_property_group_review_decision($1,'ACCEPTED',null,'2026-10-08T12:01:00Z')`, [LISTING_B]);
    await db.exec("reset role");
    const listings = await db.query<{ id: string; manual_decision: string; lifecycle_status: string }>(`select id,manual_decision,lifecycle_status from public.listings order by id`);
    assert.deepEqual(listings.rows, [{ id: LISTING_A, manual_decision: "ACCEPTED", lifecycle_status: "ACTIVE" }, { id: LISTING_B, manual_decision: "ACCEPTED", lifecycle_status: "ACTIVE" }]);
    const memberships = await db.query<{ is_current_match: boolean; match_reasons: string[] }>(`select is_current_match,match_reasons from public.listing_filter_matches order by listing_id`);
    assert.ok(memberships.rows.every((row) => row.is_current_match));
    assert.deepEqual(memberships.rows[1].match_reasons, ["manual_accept"]);
  } finally { await db.close(); }
});

test("one REJECTED decision hides every confirmed source row without deleting listing history", async () => {
  const db = await database();
  try {
    await seed(db, "portal_shared_unit_id:unit-2");
    await db.exec("set role service_role");
    await db.query(`select * from public.apply_confirmed_property_group_review_decision($1,'REJECTED','potwierdzony duplikat','2026-10-08T12:00:00Z')`, [LISTING_A]);
    await db.exec("reset role");
    const listingCount = await db.query<{ count: number }>(`select count(*)::int count from public.listings`);
    const membershipCount = await db.query<{ count: number }>(`select count(*)::int count from public.listing_filter_matches where is_current_match`);
    const rejectedCount = await db.query<{ count: number }>(`select count(*)::int count from public.listings where manual_decision='REJECTED' and lifecycle_status='REJECTED'`);
    assert.equal(listingCount.rows[0].count, 2, "source listings remain intact");
    assert.equal(membershipCount.rows[0].count, 0);
    assert.equal(rejectedCount.rows[0].count, 2);
  } finally { await db.close(); }
});
