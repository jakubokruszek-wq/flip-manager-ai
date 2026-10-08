import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const DRAFT = path.join(process.cwd(), "supabase/migrations/20261008000000_create_price_radar.sql");
const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    insert into auth.users (id) values ('${OWNER_A}'), ('${OWNER_B}');
    create table public.olx_scan_jobs (
      id uuid primary key default gen_random_uuid(), scan_run_id uuid not null, source_scan_id uuid not null,
      search_filter_id uuid not null, status text not null default 'queued', request_url text not null,
      filter_snapshot jsonb not null default '{}'::jsonb, idempotency_key text not null unique,
      attempts integer not null default 0, available_at timestamptz not null default now(), lease_token uuid, leased_until timestamptz, heartbeat_at timestamptz,
      worker_id text, result_summary jsonb, error_code text, error_message text, created_at timestamptz not null default now(),
      started_at timestamptz, finished_at timestamptz
    );
  `);
  await db.exec(fs.readFileSync(DRAFT, "utf8"));
  return db;
}

test("draft runs in embedded PostgreSQL with owner-scoped RLS and service-role-only lease RPCs", async () => {
  const db = await database();
  try {
    const policies = await db.query<{ tablename: string; qual: string | null }>(`select tablename, qual from pg_policies where schemaname='public' and tablename like 'price_radar_%' order by tablename`);
    assert.deepEqual(policies.rows.map((row) => row.tablename), ["price_radar_listings", "price_radar_runs", "price_radar_settings"]);
    for (const policy of policies.rows) {
      assert.match(policy.qual ?? "", /owner_id/);
      assert.doesNotMatch(policy.qual ?? "", /^true$/i);
    }

    const privileges = await db.query<{ anon_exec: boolean; auth_exec: boolean; service_exec: boolean; auth_update: boolean; service_update: boolean; exclusion_service: boolean; exclusion_auth: boolean }>(`
      select has_function_privilege('anon','public.claim_price_radar_run(uuid,jsonb,integer)','EXECUTE') as anon_exec,
             has_function_privilege('authenticated','public.claim_price_radar_run(uuid,jsonb,integer)','EXECUTE') as auth_exec,
             has_function_privilege('service_role','public.claim_price_radar_run(uuid,jsonb,integer)','EXECUTE') as service_exec,
             has_function_privilege('authenticated','public.set_price_radar_listing_exclusion(uuid,uuid,boolean,text)','EXECUTE') as exclusion_auth,
             has_function_privilege('service_role','public.set_price_radar_listing_exclusion(uuid,uuid,boolean,text)','EXECUTE') as exclusion_service,
             has_table_privilege('authenticated','public.price_radar_listings','UPDATE') as auth_update,
             has_table_privilege('service_role','public.price_radar_listings','UPDATE') as service_update`);
    assert.deepEqual(privileges.rows[0], { anon_exec: false, auth_exec: false, service_exec: true, exclusion_auth: false, exclusion_service: true, auth_update: false, service_update: true });

    const checkpoint = { sourceQueue: ["domiporta"], currentSourceIndex: 0, perSourceCursor: {}, sourceStatuses: { domiporta: "pending" }, sourceErrors: {}, buffer: [], bufferOffset: 0 };
    const claimed = await db.query<{ run_id: string; lease_token: string }>(`select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [OWNER_A, JSON.stringify(checkpoint)]);
    assert.equal(claimed.rows.length, 1);
    const runId = claimed.rows[0].run_id;
    const token = claimed.rows[0].lease_token;
    const competingClaim = await db.query(`select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [OWNER_A, JSON.stringify(checkpoint)]);
    assert.equal(competingClaim.rows.length, 0, "a current owner lease cannot be claimed twice");
    const otherOwnerClaim = await db.query<{ run_id: string; lease_token: string }>(`select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [OWNER_B, JSON.stringify(checkpoint)]);
    assert.equal(otherOwnerClaim.rows.length, 1, "another owner has an independent run");

    await db.query(`update price_radar_runs set lease_until=now()-interval '1 second' where id=$1`, [otherOwnerClaim.rows[0].run_id]);
    const reclaimed = await db.query<{ run_id: string; lease_token: string }>(`select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [OWNER_B, JSON.stringify(checkpoint)]);
    assert.equal(reclaimed.rows[0].run_id, otherOwnerClaim.rows[0].run_id, "an expired owner lease resumes the same run");
    assert.notEqual(reclaimed.rows[0].lease_token, otherOwnerClaim.rows[0].lease_token, "a reclaim fences the previous owner worker with a new token");
    await assert.rejects(
      db.query(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb)`, [OWNER_B, reclaimed.rows[0].run_id, otherOwnerClaim.rows[0].lease_token, JSON.stringify({})]),
      (error: unknown) => error instanceof Error && /RADAR_LEASE_LOST/.test(error.message),
    );

    const candidate = {
      source: "domiporta", external_listing_id: "fixture-1", original_url: "https://domiporta.example/fixture-1", normalized_url: "https://domiporta.example/fixture-1",
      title: "Mieszkanie w bloku", description: "fixture", price: 400000, area: 50, price_per_sqm: 8000, rooms: 2, city: "Łódź", district: "Bałuty",
      building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "fixture-hash", published_at: null,
      source_updated_at: null, cross_source_identity: "portal_shared_unit_id:unit-1", collected_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), raw_payload: {},
    };
    const persisted = await db.query<{ id: string }>(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb) as id`, [OWNER_A, runId, token, JSON.stringify(candidate)]);
    assert.ok(persisted.rows[0].id);
    await assert.rejects(
      db.query(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb)`, [OWNER_A, runId, OWNER_B, JSON.stringify(candidate)]),
      (error: unknown) => error instanceof Error && /RADAR_LEASE_LOST/.test(error.message),
    );

    const completed = await db.query<{ accepted: boolean }>(`select public.checkpoint_price_radar_run($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,1,1,'completed',null,120) as accepted`, [OWNER_A, runId, token, JSON.stringify({ ...checkpoint, currentSourceIndex: 1 }), JSON.stringify({ domiporta: "completed" })]);
    assert.equal(completed.rows[0].accepted, true);
    const sibling = await db.query<{ id: string }>(`insert into price_radar_listings(owner_id,source,external_listing_id,original_url,normalized_url,title,description,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash,cross_source_identity) values ($1,'olx','sibling','https://www.olx.pl/oferta/sibling','https://www.olx.pl/oferta/sibling','Mieszkanie','',400000,50,8000,2,'Łódź','Bałuty','blok','secondary','fresh_renovation','sibling-hash','portal_shared_unit_id:unit-1') returning id`, [OWNER_A]);
    const excluded = await db.query<{ updated: boolean }>(`select public.set_price_radar_listing_exclusion($1::uuid,$2::uuid,true,'ręczne wykluczenie') as updated`, [OWNER_A, persisted.rows[0].id]);
    assert.equal(excluded.rows[0].updated, true);
    const excludedRows = await db.query<{ count: number }>(`select count(*)::int as count from price_radar_listings where owner_id=$1 and cross_source_identity='portal_shared_unit_id:unit-1' and excluded_at is not null`, [OWNER_A]);
    assert.equal(excludedRows.rows[0].count, 2, "manual exclusion follows the explicit cross-source identity group");
    const newRun = await db.query<{ run_id: string; lease_token: string }>(`select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [OWNER_A, JSON.stringify({ ...checkpoint, sourceQueue: ["olx"], sourceStatuses: { olx: "running" } })]);
    const olxRunId = newRun.rows[0].run_id;
    const olxToken = newRun.rows[0].lease_token;
    const reimported = await db.query<{ id: string }>(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb) as id`, [OWNER_A, olxRunId, olxToken, JSON.stringify({ ...candidate, price: 425000, price_per_sqm: 8500, collected_at: new Date().toISOString(), last_seen_at: new Date().toISOString() })]);
    assert.equal(reimported.rows[0].id, persisted.rows[0].id, "same source identity updates the same Radar listing on reimport");
    const reimportedRow = await db.query<{ price: string; excluded_at: string | null; excluded_reason: string | null }>(`select price::text,excluded_at::text,excluded_reason from price_radar_listings where id=$1`, [persisted.rows[0].id]);
    assert.equal(reimportedRow.rows[0].price, "425000");
    assert.ok(reimportedRow.rows[0].excluded_at, "a changed price/reimport preserves the prior Radar exclusion");
    assert.equal(reimportedRow.rows[0].excluded_reason, "ręczne wykluczenie");
    const queue = await db.query<{ id: string }>(`insert into public.olx_scan_jobs(context_type,scan_run_id,source_scan_id,search_filter_id,radar_owner_id,radar_run_id,radar_lease_token,request_url,filter_snapshot,idempotency_key,status,lease_token,leased_until,heartbeat_at,worker_id,attempts) values ('price_radar',$1,null,null,$2,$1,$3,'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/','{}','radar:$1:olx',$4,$5,now()+interval '120 sec',now(),'radar-worker',1) returning id`, [olxRunId, OWNER_A, olxToken, "running", "00000000-0000-4000-8000-000000000099"]);
    const heartbeat = await db.query<{ accepted: boolean }>(`select public.heartbeat_price_radar_olx_job($1::uuid,'radar-worker',$2::uuid,$3::uuid,120) as accepted`, [queue.rows[0].id, "00000000-0000-4000-8000-000000000099", olxToken]);
    assert.equal(heartbeat.rows[0].accepted, true);
    const finishedCheckpoint = { sourceQueue: ["olx"], currentSourceIndex: 1, perSourceCursor: {}, sourceStatuses: { olx: "completed" }, sourceErrors: {}, buffer: [], bufferOffset: 0 };
    const finalized = await db.query<{ accepted: boolean }>(`select public.finalize_price_radar_olx_job($1::uuid,$2::uuid,$3::uuid,$4::uuid,'radar-worker',$5::uuid,$6::jsonb,$7::jsonb,1,0,'completed',null,'completed','{}',null,null) as accepted`, [OWNER_A, olxRunId, olxToken, queue.rows[0].id, "00000000-0000-4000-8000-000000000099", JSON.stringify(finishedCheckpoint), JSON.stringify({ olx: "completed" })]);
    assert.equal(finalized.rows[0].accepted, true);
    const queueState = await db.query<{ status: string; source_scan_id: string | null; search_filter_id: string | null }>(`select status,source_scan_id,search_filter_id from olx_scan_jobs where id=$1`, [queue.rows[0].id]);
    assert.deepEqual(queueState.rows[0], { status: "completed", source_scan_id: null, search_filter_id: null }, "Radar OLX uses the existing worker queue without Finder rows");
    const restored = await db.query<{ updated: boolean }>(`select public.set_price_radar_listing_exclusion($1::uuid,$2::uuid,false,null) as updated`, [OWNER_A, persisted.rows[0].id]);
    assert.equal(restored.rows[0].updated, true);
    const restoredRows = await db.query<{ count: number }>(`select count(*)::int as count from price_radar_listings where owner_id=$1 and cross_source_identity='portal_shared_unit_id:unit-1' and excluded_at is null`, [OWNER_A]);
    assert.equal(restoredRows.rows[0].count, 2, "manual restore follows the same confirmed group");
    const ownerRows = await db.query<{ owner_id: string; count: number }>(`select owner_id,count(*)::int as count from public.price_radar_listings group by owner_id`);
    assert.deepEqual(ownerRows.rows, [{ owner_id: OWNER_A, count: 2 }], "the unrelated second listing stays in the same owner's Radar context and no other owner receives rows");
    assert.ok(sibling.rows[0].id, "the confirmed cross-source sibling remains present in the embedded SQL test");
  } finally {
    await db.close();
  }
});
