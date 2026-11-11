import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { emptyWorkspace } from "./model.ts";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", PROPERTY = "11111111-1111-4111-8111-111111111111";
async function database() {
 const db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('app_metadata',jsonb_build_object('role',current_setting('request.jwt.claim.role',true))) $$;
 create table public.properties(id uuid primary key,status text,notes text,images jsonb);
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 grant usage on schema public,auth to authenticated; grant select on public.properties to authenticated; grant all on public.properties to service_role;
 insert into auth.users values ('${OWNER}'),('${OTHER}');
 insert into public.properties values ('${PROPERTY}','draft','Original notes','["https://example.test/a.jpg"]');`);
 const migration = fs.readFileSync(new URL("../../supabase/migrations/20261110221903_property_workspaces.sql", import.meta.url), "utf8");
 assert.equal(migration, fs.readFileSync(new URL("../../docs/sql/property-workspaces.sql", import.meta.url), "utf8"));
 await db.exec(migration);
 return db;
}
async function asOwner(db: PGlite, owner = OWNER, role = "operator") { await db.exec(`reset role; set request.jwt.claim.sub = '${owner}'; set request.jwt.claim.role = '${role}'; set role authenticated;`); }
test("acquisition updates the same property atomically, preserves original data, CAS rejects stale tabs", async () => {
 const db = await database(); try {
 await db.exec("set role service_role");
 const w = emptyWorkspace(); w.stage = "acquired"; w.purchasePrice = 30_000_000; w.purchaseDate = "2026-11-10";
 const first = await db.query<{ version: number }>("select public.save_property_workspace($1,$2,0,$3::jsonb) version", [PROPERTY, OWNER, JSON.stringify(w)]);
 assert.equal(first.rows[0].version, 1);
 assert.equal((await db.query("select * from property_workspace_events")).rows.length, 1);
 const original = await db.query<{ status: string; notes: string; images: string[] }>("select status,notes,images from properties where id=$1", [PROPERTY]);
 assert.equal(original.rows[0].status, "acquired"); assert.equal(original.rows[0].notes, "Original notes"); assert.deepEqual(original.rows[0].images, ["https://example.test/a.jpg"]);
 await assert.rejects(db.query("select public.save_property_workspace($1,$2,0,$3::jsonb)", [PROPERTY, OWNER, JSON.stringify(w)]), /WORKSPACE_CONFLICT/);
 w.stage = "renovation";
 await db.query("select public.save_property_workspace($1,$2,1,$3::jsonb)", [PROPERTY, OWNER, JSON.stringify(w)]);
 await assert.rejects(db.query("select public.save_property_workspace($1,$2,1,$3::jsonb)", [PROPERTY, OWNER, JSON.stringify({ ...w, stage: "sold" })]), /SALE_DETAILS_REQUIRED/);
 assert.equal((await db.query<{ status: string }>("select status from properties")).rows[0].status, "renovation");
 } finally { await db.close(); }
});
test("private workspace is invisible to other operators, role claims cannot bypass owner checks", async () => {
 const db = await database(); try {
 await db.exec("set role service_role"); await db.query("select public.save_property_workspace($1,$2,0,$3::jsonb)", [PROPERTY, OWNER, JSON.stringify(emptyWorkspace())]);
 await asOwner(db);
 assert.equal((await db.query("select * from property_workspaces")).rows.length, 1);
 await assert.rejects(db.query("update property_workspaces set version=20"), /permission denied/);
 await assert.rejects(db.query("select * from property_workspace_uploads"), /permission denied/);
 await asOwner(db, OTHER);
 assert.equal((await db.query("select * from property_workspaces")).rows.length, 0);
 await assert.rejects(db.query("select public.save_property_workspace($1,$2,1,$3::jsonb)", [PROPERTY, OWNER, JSON.stringify(emptyWorkspace())]), /permission denied/);
 await asOwner(db, OWNER, "viewer"); assert.equal((await db.query("select * from property_workspaces")).rows.length, 0);
 await assert.rejects(db.query("select public.save_property_workspace($1,$2,1,$3::jsonb)", [PROPERTY, OWNER, JSON.stringify(emptyWorkspace())]), /permission denied/);
 await db.exec("reset role");
 const security = await db.query<{ anon: boolean; definer: boolean; public: boolean }>("select has_function_privilege('anon','public.save_property_workspace(uuid,uuid,integer,jsonb)','execute') anon, (select prosecdef from pg_proc where oid='public.save_property_workspace(uuid,uuid,integer,jsonb)'::regprocedure) definer, (select public from storage.buckets where id='property-workspace-private') public");
 assert.equal(security.rows[0].anon, false); assert.equal(security.rows[0].definer, false); assert.equal(security.rows[0].public, false);
 } finally { await db.close(); }
});
