import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const IDENTITY_DRAFT = path.join(ROOT, "supabase/migrations/20261008120000_add_confirmed_property_identity.sql");
const MANUAL_DRAFT = path.join(ROOT, "supabase/migrations/20261009120000_add_finder_identity_evidence_and_manual_groups.sql");
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILTER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create table public.listings(id uuid primary key, source text, price numeric, cross_source_identity text, lifecycle_status text, manual_decision text, manual_decision_reason text, review_reason text, missing_fields jsonb not null default '[]'::jsonb, archived_at timestamptz, status text not null default 'active');
    create table public.search_filters(id uuid primary key);
    create table public.listing_filter_matches(listing_id uuid not null, search_filter_id uuid not null, is_current_match boolean not null default true, primary key(listing_id,search_filter_id));
    create table public.properties(id uuid primary key, cross_source_identity text);
    create table public.price_radar_listings(cross_source_identity text);
    grant usage on schema public to anon, authenticated, service_role;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant select, insert, update, delete on all tables in schema public to service_role;
  `);
  await db.exec(fs.readFileSync(IDENTITY_DRAFT, "utf8"));
  await db.exec(fs.readFileSync(MANUAL_DRAFT, "utf8"));
  await db.query(`insert into public.search_filters(id) values ($1)`, [FILTER]);
  await db.query(`insert into public.listings(id,source,price,status,identity_evidence) values
    ($1,'gratka',365000,'active',$4::jsonb),($2,'morizon',389000,'active',$5::jsonb),($3,'olx',245000,'active',$6::jsonb)`, [
    A, B, C,
    JSON.stringify({ buildingKey: "lodz|piotrkowska|12", apartmentNumber: "4", unitKey: "lodz|piotrkowska|12|unit:4", area: 52, rooms: 2, marketType: "secondary", buildingType: "kamienica" }),
    JSON.stringify({ buildingKey: "lodz|piotrkowska|12", apartmentNumber: "4", unitKey: "lodz|piotrkowska|12|unit:4", area: 52.3, rooms: 2, marketType: "secondary", buildingType: "kamienica" }),
    JSON.stringify({ buildingKey: "lodz|piotrkowska|12", apartmentNumber: "5", unitKey: "lodz|piotrkowska|12|unit:5", area: 52, rooms: 2, marketType: "secondary", buildingType: "kamienica" }),
  ]);
  await db.query(`insert into public.listing_filter_matches(listing_id,search_filter_id) values ($1,$4),($2,$4),($3,$4)`, [A, B, C, FILTER]);
  return db;
}

test("manual identity writes are invoker-only and service_role-only; authenticated reads are owner-scoped by RLS", async () => {
  const db = await database();
  try {
    const grants = await db.query<{ anon_exec: boolean; authenticated_exec: boolean; service_exec: boolean; anon_group_read: boolean; authenticated_group_read: boolean; authenticated_group_write: boolean; rls_enabled: boolean; security_definer: boolean; config: string[] | null }>(`
      select has_function_privilege('anon','public.manage_finder_listing_identity(uuid,uuid,text,uuid,uuid)','EXECUTE') anon_exec,
        has_function_privilege('authenticated','public.manage_finder_listing_identity(uuid,uuid,text,uuid,uuid)','EXECUTE') authenticated_exec,
        has_function_privilege('service_role','public.manage_finder_listing_identity(uuid,uuid,text,uuid,uuid)','EXECUTE') service_exec,
        has_table_privilege('anon','public.finder_listing_identity_groups','SELECT') anon_group_read,
        has_table_privilege('authenticated','public.finder_listing_identity_groups','SELECT') authenticated_group_read,
        has_table_privilege('authenticated','public.finder_listing_identity_groups','INSERT') authenticated_group_write,
        (select relrowsecurity from pg_class where oid='public.finder_listing_identity_groups'::regclass) rls_enabled,
        p.prosecdef security_definer,p.proconfig config
      from pg_proc p where p.oid='public.manage_finder_listing_identity(uuid,uuid,text,uuid,uuid)'::regprocedure`);
    assert.deepEqual(grants.rows[0], { anon_exec: false, authenticated_exec: false, service_exec: true, anon_group_read: false, authenticated_group_read: true, authenticated_group_write: false, rls_enabled: true, security_definer: false, config: ["search_path=public"] });
  } finally { await db.close(); }
});

test("authenticated users can read only their own manual identity rows and cannot write them directly", async () => {
  const db = await database();
  try {
    await db.query(`insert into public.finder_listing_identity_groups(owner_id,search_filter_id,group_id,listing_id) values ($1,$2,$3,$4),($5,$2,$3,$6)`, [OWNER, FILTER, C, A, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", B]);
    await db.exec("select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',false); set role authenticated;");
    const own = await db.query<{ count: number }>(`select count(*)::int as count from public.finder_listing_identity_groups`);
    assert.equal(own.rows[0].count, 1);
    await db.exec("reset role; select set_config('request.jwt.claim.sub','dddddddd-dddd-4ddd-8ddd-dddddddddddd',false); set role authenticated;");
    const other = await db.query<{ count: number }>(`select count(*)::int as count from public.finder_listing_identity_groups`);
    assert.equal(other.rows[0].count, 0);
    await assert.rejects(db.query(`insert into public.finder_listing_identity_groups(owner_id,search_filter_id,group_id,listing_id) values ($1,$2,$3,$4)`, [OWNER, FILTER, C, B]), /permission denied for table finder_listing_identity_groups/);
  } finally { await db.close(); }
});

test("RPC links only within the requested filter, preserves source rows, and unlink writes a durable not_link pair", async () => {
  const db = await database();
  try {
    await db.exec("set role service_role");
    const linked = await db.query<{ group_id: string; affected_listing_ids: string[] }>(`select group_id,affected_listing_ids from public.manage_finder_listing_identity($1,$2,'link',$3,$4)`, [OWNER, FILTER, A, B]);
    assert.ok(linked.rows[0].group_id);
    assert.deepEqual(linked.rows[0].affected_listing_ids.sort(), [A, B].sort());
    const sourceRows = await db.query<{ count: number }>(`select count(*)::int count from public.listings`);
    assert.equal(sourceRows.rows[0].count, 3, "grouping does not delete or rewrite source rows");
    await db.query(`update public.listings set price=399000 where id=$1`, [A]);
    const afterReimport = await db.query<{ group_id: string; count: number }>(`select group_id,count(*)::int count from public.finder_listing_identity_groups where owner_id=$1 and search_filter_id=$2 group by group_id`, [OWNER, FILTER]);
    assert.deepEqual(afterReimport.rows, [{ group_id: linked.rows[0].group_id, count: 2 }], "a source price update/reimport does not erase the saved manual identity decision");
    await db.query(`select * from public.manage_finder_listing_identity($1,$2,'unlink',$3,null)`, [OWNER, FILTER, A]);
    await db.exec("reset role");
    const groupCount = await db.query<{ count: number }>(`select count(*)::int count from public.finder_listing_identity_groups`);
    const block = await db.query<{ decision: string; listing_a: string; listing_b: string }>(`select decision,listing_a,listing_b from public.finder_listing_identity_decisions where decision='not_link'`);
    assert.equal(groupCount.rows[0].count, 0, "a singleton is not represented as a group");
    assert.deepEqual(block.rows, [{ decision: "not_link", listing_a: A, listing_b: B }]);
  } finally { await db.close(); }
});

test("manual link rejects explicit different apartment numbers and listings outside the filter", async () => {
  const db = await database();
  try {
    await db.exec("set role service_role");
    await assert.rejects(db.query(`select * from public.manage_finder_listing_identity($1,$2,'link',$3,$4)`, [OWNER, FILTER, A, C]), /FINDER_IDENTITY_CONTRADICTORY_EVIDENCE/);
    await assert.rejects(db.query(`select * from public.manage_finder_listing_identity($1,$2,'link',$3,'99999999-9999-4999-8999-999999999999')`, [OWNER, FILTER, A]), /FINDER_IDENTITY_LISTING_OUTSIDE_FILTER/);
  } finally { await db.close(); }
});

test("not_link decisions are scoped by owner and filter", async () => {
  const db = await database();
  try {
    await db.exec("set role service_role");
    await db.query(`select * from public.manage_finder_listing_identity($1,$2,'not_link',$3,$4)`, [OWNER, FILTER, A, B]);
    await db.exec("reset role");
    const rows = await db.query<{ count: number }>(`select count(*)::int count from public.finder_listing_identity_decisions where owner_id=$1 and search_filter_id=$2`, [OWNER, FILTER]);
    const otherOwner = await db.query<{ count: number }>(`select count(*)::int count from public.finder_listing_identity_decisions where owner_id=$1`, ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    assert.equal(rows.rows[0].count, 1);
    assert.equal(otherOwner.rows[0].count, 0);
  } finally { await db.close(); }
});
