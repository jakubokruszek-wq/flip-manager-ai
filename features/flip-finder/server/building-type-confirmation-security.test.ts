import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";

/**
 * Security of the only schema change the Finder deployment needs
 * (finder_building_type_confirmations) and of its operator-only write route.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const MIGRATION = path.join(ROOT, "supabase/migrations/20261013120000_add_finder_building_type_confirmations.sql");
const LISTING = "20000000-0000-4000-8000-000000000002";

test("the confirmations migration only adds its own table: read-only for authenticated, no anon access, writes only via service role", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.listings(id uuid primary key, price numeric, building_type text);
      create table public.listing_snapshots(id uuid primary key default gen_random_uuid(), listing_id uuid references public.listings(id), price numeric);
      insert into public.listings values ('${LISTING}', 269000, 'blok');
      insert into public.listing_snapshots(listing_id, price) values ('${LISTING}', 279000), ('${LISTING}', 269000);
    `);
    const before = (await db.query("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows;
    await db.exec(fs.readFileSync(MIGRATION, "utf8"));
    const after = (await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1")).rows;
    assert.deepEqual(after.map((row) => row.table_name).filter((name) => !before.some((item) => (item as { table_name: string }).table_name === name)), ["finder_building_type_confirmations"]);
    const privileges = (await db.query<Record<string, boolean>>(`select
      has_table_privilege('anon', 'public.finder_building_type_confirmations', 'SELECT') anon_select,
      has_table_privilege('anon', 'public.finder_building_type_confirmations', 'INSERT') anon_insert,
      has_table_privilege('authenticated', 'public.finder_building_type_confirmations', 'SELECT') auth_select,
      has_table_privilege('authenticated', 'public.finder_building_type_confirmations', 'INSERT') auth_insert,
      has_table_privilege('authenticated', 'public.finder_building_type_confirmations', 'UPDATE') auth_update,
      has_table_privilege('authenticated', 'public.finder_building_type_confirmations', 'DELETE') auth_delete,
      has_table_privilege('service_role', 'public.finder_building_type_confirmations', 'INSERT') service_insert,
      (select relrowsecurity from pg_class where oid = 'public.finder_building_type_confirmations'::regclass) rls`)).rows[0];
    assert.deepEqual(privileges, { anon_select: false, anon_insert: false, auth_select: true, auth_insert: false, auth_update: false, auth_delete: false, service_insert: true, rls: true });
    await assert.rejects(db.query(`insert into public.finder_building_type_confirmations(listing_id, building_type, confirmed_by) values ('${LISTING}', 'pałac', gen_random_uuid())`), /check/u, "only known building categories are accepted");
    await db.exec(`insert into public.finder_building_type_confirmations(listing_id, building_type, confirmed_by) values ('${LISTING}', 'blok', gen_random_uuid())`);
    assert.deepEqual((await db.query("select price from public.listing_snapshots order by price")).rows, [{ price: "269000" }, { price: "279000" }], "price history untouched");
    assert.deepEqual((await db.query("select building_type from public.listings")).rows, [{ building_type: "blok" }], "listing data untouched");
  } finally { await db.close(); }
});

let currentDb = new FakeFacebookSupabase();
let operatorAllowed = true;
let adminCreated = 0;
mock.module("@/features/auth/operator", { namedExports: {
  requireOperator: async () => { if (!operatorAllowed) throw new Error("NO_OPERATOR"); return { id: "operator-1", email: "operator@example.test" }; },
  operatorAuthorizationResponse: () => Response.json({ ok: false, code: "OPERATOR_SESSION_REQUIRED" }, { status: 401 }),
} });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { adminCreated += 1; return currentDb; } } });
const { POST } = await import("../../../app/api/flip-finder/listings/[id]/building-type/route.ts");
const call = (id: string, body: unknown) => POST(new Request(`http://localhost/api/flip-finder/listings/${id}/building-type`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

test("building-type confirmation: anonymous requests stop before any database client is created", async () => {
  operatorAllowed = false; adminCreated = 0;
  const response = await call(LISTING, { buildingType: "blok" });
  assert.equal(response.status, 401);
  assert.equal(adminCreated, 0);
  operatorAllowed = true;
});

test("building-type confirmation validates the listing id and the building type", async () => {
  currentDb = new FakeFacebookSupabase().seed("finder_building_type_confirmations", []);
  assert.equal((await call("not-a-uuid", { buildingType: "blok" })).status, 422);
  assert.equal((await call(LISTING, { buildingType: "pałac" })).status, 422);
  assert.equal((await call(LISTING, { buildingType: "<script>" })).status, 422);
  assert.equal(currentDb.rows("finder_building_type_confirmations").length, 0);
});

test("building-type confirmation records the operator, trims the note, and can be withdrawn", async () => {
  currentDb = new FakeFacebookSupabase().seed("finder_building_type_confirmations", []);
  const response = await call(LISTING, { buildingType: "blok", note: `  ${"x".repeat(600)}  ` });
  assert.equal(response.status, 200);
  const [row] = currentDb.rows("finder_building_type_confirmations");
  assert.equal(row.listing_id, LISTING);
  assert.equal(row.building_type, "blok");
  assert.equal(row.confirmed_by, "operator-1", "the operator comes from the session, never from the request body");
  assert.equal(String(row.note).length, 500);
  assert.equal((await call(LISTING, { buildingType: null })).status, 200);
  assert.equal(currentDb.rows("finder_building_type_confirmations").length, 0);
});

test("building-type confirmation before the migration answers 503 with an explanation instead of failing silently", async () => {
  currentDb = new FakeFacebookSupabase();
  currentDb.failNext("finder_building_type_confirmations", "upsert", 'relation "public.finder_building_type_confirmations" does not exist', 1, "42P01");
  const response = await call(LISTING, { buildingType: "blok" });
  assert.equal(response.status, 503);
  assert.match((await response.json() as { message: string }).message, /migracji/u);
});
