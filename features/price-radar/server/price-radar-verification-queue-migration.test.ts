import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const BASE = path.join(process.cwd(), "supabase/migrations/20261008000000_create_price_radar.sql");
const MIGRATION = path.join(process.cwd(), "supabase/migrations/20261012130000_add_price_radar_verification_queue.sql");
const OWNER = "00000000-0000-4000-8000-000000000083";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000084";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users(id) values ('${OWNER}'),('${OTHER_OWNER}');
    create table public.olx_scan_jobs (
      id uuid primary key default gen_random_uuid(), scan_run_id uuid not null, source_scan_id uuid,
      search_filter_id uuid, status text not null default 'queued', request_url text not null,
      filter_snapshot jsonb not null default '{}'::jsonb, idempotency_key text not null unique,
      attempts integer not null default 0, available_at timestamptz not null default now(), lease_token uuid,
      leased_until timestamptz, heartbeat_at timestamptz, worker_id text, result_summary jsonb,
      error_code text, error_message text, created_at timestamptz not null default now(),
      started_at timestamptz, finished_at timestamptz
    );
  `);
  await db.exec(fs.readFileSync(BASE, "utf8"));
  // Exercise the exact draft file; no copied or reconstructed SQL is used.
  await db.exec(fs.readFileSync(MIGRATION, "utf8"));
  return db;
}

async function asRole<T>(db: PGlite, role: "anon" | "authenticated" | "service_role", action: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try { return await action(); } finally { await db.exec("reset role"); }
}

function candidate(externalId: string) {
  return {
    source: "allegro_lokalnie", external_listing_id: externalId,
    original_url: `https://allegrolokalnie.pl/oferta/${externalId}`,
    normalized_url: `https://allegrolokalnie.pl/oferta/${externalId}`,
    title: "Mieszkanie na sprzedaż — Łódź Śródmieście",
    source_snapshot: { description: "Oferta sprzedaży pojedynczego mieszkania.", contentHash: `hash-${externalId}`, collectedAt: "2026-10-11T10:00:00Z" },
    confirmed_fields: ["apartment_sale"], missing_fields: ["standard"], contradictory_fields: [],
    routing_reasons: ["detail_not_confirmed", "missing:standard"], field_evidence: { apartment_sale: "Mieszkanie na sprzedaż" },
    first_seen_at: "2026-10-11T09:00:00Z", last_seen_at: "2026-10-11T10:00:00Z",
  };
}

const decision = {
  apartmentSaleConfirmed: true, price: 400000, area: 40, rooms: 2, city: "Łódź",
  district: "Śródmieście", buildingType: "apartamentowiec", marketType: "secondary", qualityCategory: "ready_high_standard",
};

test("the exact verification queue draft executes with owner RLS and service-role-only mutation RPCs", async () => {
  const migration = fs.readFileSync(MIGRATION, "utf8");
  assert.match(migration, /create table if not exists public\.price_radar_verification_queue/iu);
  assert.match(migration, /grant execute on function public\.resolve_price_radar_verification_candidate\(uuid, uuid, uuid, jsonb\) to service_role/iu);
  const db = await database();
  try {
    const permissions = await db.query<Record<string, boolean>>(`
      select c.relrowsecurity as rls,
        has_table_privilege('authenticated','public.price_radar_verification_queue','SELECT') as authenticated_select,
        has_table_privilege('anon','public.price_radar_verification_queue','SELECT') as anon_select,
        has_table_privilege('service_role','public.price_radar_verification_queue','INSERT') as service_insert,
        has_function_privilege('service_role','public.upsert_price_radar_verification_candidate(uuid,jsonb)','EXECUTE') as upsert_service,
        has_function_privilege('service_role','public.set_price_radar_verification_queue_rejection(uuid,uuid,boolean)','EXECUTE') as reject_service,
        has_function_privilege('service_role','public.resolve_price_radar_verification_candidate(uuid,uuid,uuid,jsonb)','EXECUTE') as resolve_service,
        has_function_privilege('anon','public.upsert_price_radar_verification_candidate(uuid,jsonb)','EXECUTE') as upsert_anon,
        has_function_privilege('authenticated','public.resolve_price_radar_verification_candidate(uuid,uuid,uuid,jsonb)','EXECUTE') as resolve_auth
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relname='price_radar_verification_queue'`);
    assert.deepEqual(permissions.rows[0], {
      rls: true, authenticated_select: true, anon_select: false, service_insert: true,
      upsert_service: true, reject_service: true, resolve_service: true, upsert_anon: false, resolve_auth: false,
    });
    const policies = await db.query<{ policyname: string; qual: string | null }>(
      `select policyname,qual from pg_policies where schemaname='public' and tablename='price_radar_verification_queue'`);
    assert.deepEqual(policies.rows, [{ policyname: "price_radar_verification_queue_owner_select", qual: "(owner_id = ( SELECT auth.uid() AS uid))" }]);

    const inserted = await asRole(db, "service_role", () => db.query<{ id: string }>(
      `select public.upsert_price_radar_verification_candidate($1::uuid,$2::jsonb) as id`, [OWNER, JSON.stringify(candidate("sbd"))]));
    const queueId = inserted.rows[0]!.id;
    await asRole(db, "service_role", () => db.query(
      `select public.upsert_price_radar_verification_candidate($1::uuid,$2::jsonb)`, [OTHER_OWNER, JSON.stringify(candidate("other-owner-offer"))]));
    await db.exec("set role authenticated");
    try {
      await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [OWNER]);
      const ownerRows = await db.query<{ owner_id: string; external_listing_id: string }>(`select owner_id::text,external_listing_id from public.price_radar_verification_queue order by external_listing_id`);
      assert.deepEqual(ownerRows.rows, [{ owner_id: OWNER, external_listing_id: "sbd" }], "authenticated SELECT sees only rows owned by auth.uid()");
      await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [OTHER_OWNER]);
      const otherRows = await db.query<{ owner_id: string; external_listing_id: string }>(`select owner_id::text,external_listing_id from public.price_radar_verification_queue`);
      assert.deepEqual(otherRows.rows, [{ owner_id: OTHER_OWNER, external_listing_id: "other-owner-offer" }], "the owner policy follows the authenticated user, not service-side filters");
    } finally { await db.exec("reset role"); }
    const saved = await asRole(db, "service_role", () => db.query<{ id: string }>(
      `select public.resolve_price_radar_verification_candidate($1::uuid,$2::uuid,$1::uuid,$3::jsonb) as id`, [OWNER, queueId, JSON.stringify(decision)]));
    const listingId = saved.rows[0]!.id;
    const listing = await db.query<{ price: string; area: string; price_per_sqm: string; rooms: number; market_type: string; renovation_status: string }>(
      `select price::text,area::text,price_per_sqm::text,rooms,market_type,renovation_status from public.price_radar_listings where id=$1`, [listingId]);
    assert.deepEqual(listing.rows[0], { price: "400000", area: "40", price_per_sqm: "10000.0000000000000000", rooms: 2, market_type: "secondary", renovation_status: "turnkey_finish" });

    // Reimport refreshes evidence but preserves the confirmed operator decision and linked row.
    const reimport = candidate("sbd");
    reimport.source_snapshot = { ...reimport.source_snapshot, contentHash: "new-content", description: "Updated public offer" };
    reimport.last_seen_at = "2026-10-11T11:00:00Z";
    const reimported = await asRole(db, "service_role", () => db.query<{ id: string }>(
      `select public.upsert_price_radar_verification_candidate($1::uuid,$2::jsonb) as id`, [OWNER, JSON.stringify(reimport)]));
    assert.equal(reimported.rows[0]!.id, queueId);
    const afterReimport = await db.query<{ status: string; decision_by: string; radar_listing_id: string; content_hash: string }>(
      `select status,decision_by::text,radar_listing_id::text,source_snapshot->>'contentHash' as content_hash from public.price_radar_verification_queue where id=$1`, [queueId]);
    assert.deepEqual(afterReimport.rows[0], { status: "confirmed", decision_by: OWNER, radar_listing_id: listingId, content_hash: "new-content" });
    const secondResolution = await asRole(db, "service_role", () => db.query<{ id: string }>(
      `select public.resolve_price_radar_verification_candidate($1::uuid,$2::uuid,$1::uuid,$3::jsonb) as id`, [OWNER, queueId, JSON.stringify({ ...decision, price: 410000 })]));
    assert.equal(secondResolution.rows[0]!.id, listingId, "correction updates the same comparison row");
    const rowCount = await db.query<{ count: number }>(`select count(*)::int as count from public.price_radar_listings where owner_id=$1 and source='allegro_lokalnie' and external_listing_id='sbd'`, [OWNER]);
    assert.equal(rowCount.rows[0]!.count, 1);

    const rejectedId = (await asRole(db, "service_role", () => db.query<{ id: string }>(
      `select public.upsert_price_radar_verification_candidate($1::uuid,$2::jsonb) as id`, [OWNER, JSON.stringify(candidate("reject-me"))]))).rows[0]!.id;
    const reject = await asRole(db, "service_role", () => db.query<{ result: boolean }>(
      `select public.set_price_radar_verification_queue_rejection($1::uuid,$2::uuid,true) as result`, [OWNER, rejectedId]));
    assert.equal(reject.rows[0]!.result, true, "reject RPC works as the production service role");
    const restore = await asRole(db, "service_role", () => db.query<{ result: boolean }>(
      `select public.set_price_radar_verification_queue_rejection($1::uuid,$2::uuid,false) as result`, [OWNER, rejectedId]));
    assert.equal(restore.rows[0]!.result, true);
    const state = await db.query<{ status: string; rejected_at: string | null }>(`select status,rejected_at::text from public.price_radar_verification_queue where id=$1`, [rejectedId]);
    assert.deepEqual(state.rows[0], { status: "pending", rejected_at: null });

    for (const role of ["anon", "authenticated"] as const) {
      await db.exec(`set role ${role}`);
      try {
        await assert.rejects(db.query(`select public.upsert_price_radar_verification_candidate($1::uuid,$2::jsonb)`, [OWNER, JSON.stringify(candidate("no"))]));
        await assert.rejects(db.query(`select public.set_price_radar_verification_queue_rejection($1::uuid,$2::uuid,true)`, [OWNER, rejectedId]));
        await assert.rejects(db.query(`select public.resolve_price_radar_verification_candidate($1::uuid,$2::uuid,$1::uuid,$3::jsonb)`, [OWNER, rejectedId, JSON.stringify(decision)]));
      } finally { await db.exec("reset role"); }
    }
  } finally {
    await db.close();
  }
});
