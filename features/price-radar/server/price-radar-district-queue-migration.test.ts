import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const BASE = path.join(process.cwd(), "supabase/migrations/20261008000000_create_price_radar.sql");
const QUEUE = path.join(process.cwd(), "supabase/migrations/20261011154631_add_radar_district_queue.sql");
const OWNER = "00000000-0000-4000-8000-000000000071";
const CROSS_SOURCE_ID = "portal_shared_unit_id:district-queue-test";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    insert into auth.users (id) values ('${OWNER}');
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
  await db.exec(fs.readFileSync(QUEUE, "utf8"));
  return db;
}

type TestRole = "anon" | "authenticated" | "service_role";

async function asRole<T>(db: PGlite, role: TestRole, action: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await action();
  } finally {
    await db.exec("reset role");
  }
}

async function assertRpcDenied(db: PGlite, role: "anon" | "authenticated", query: string, params: unknown[]) {
  await db.exec(`set role ${role}`);
  try {
    await assert.rejects(db.query(query, params), (error: unknown) => {
      const pgError = error as { code?: unknown; message?: unknown };
      return pgError.code === "42501" || /permission denied for function/iu.test(String(pgError.message ?? ""));
    }, `${role} must not execute district queue mutation RPCs`);
  } finally {
    await db.exec("reset role");
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    source: "domiporta",
    external_listing_id: "portal-123",
    original_url: "https://domiporta.example/oferta/portal-123",
    normalized_url: "https://domiporta.example/oferta/portal-123",
    title: "Mieszkanie po remoncie",
    description: "Blok, rynek wtórny, świeży remont. Ulica Łanowa, Teofilów.",
    price: 419000,
    area: 45,
    price_per_sqm: 419000 / 45,
    rooms: 2,
    city: "Łódź",
    building_type: "blok",
    market_type: "secondary",
    renovation_status: "fresh_renovation",
    content_hash: "district-queue-content-v1",
    cross_source_identity: CROSS_SOURCE_ID,
    published_at: "2026-10-01T10:00:00.000Z",
    source_updated_at: null,
    collected_at: "2026-10-11T10:00:00.000Z",
    last_seen_at: "2026-10-11T10:00:00.000Z",
    raw_payload: { imageUrls: ["https://images.example.test/a.jpg"], sourceProof: "Teofilów" },
    suggested_district: "Bałuty",
    suggestion_source: "ai",
    suggestion_evidence: "Opis zawiera nazwę Teofilów.",
    ...overrides,
  };
}

async function upsert(db: PGlite, value: ReturnType<typeof payload>) {
  return asRole(db, "service_role", async () => {
    const result = await db.query<{ id: string }>(
      `select public.upsert_price_radar_district_queue_candidate($1::uuid,$2::jsonb) as id`,
      [OWNER, JSON.stringify(value)],
    );
    return result.rows[0]!.id;
  });
}

test("the executed district queue migration contains the correct identity ordering and service-role rejection grant", () => {
  const migrationSql = fs.readFileSync(QUEUE, "utf8");
  assert.match(
    migrationSql,
    /order by\s*\(l\.external_listing_id\s*=\s*queue_row\.external_listing_id\)\s+desc,\s*l\.last_seen_at\s+desc/iu,
    "the assignment lookup prefers the exact portal ID from the locked queue row",
  );
  assert.doesNotMatch(migrationSql, /\bp_listing\b/u, "the assignment RPC has no p_listing parameter");
  assert.match(
    migrationSql,
    /grant execute on function public\.set_price_radar_district_queue_rejection\(uuid, uuid, boolean\) to service_role;/iu,
    "service_role must be granted the reject/restore RPC",
  );
});

test("the exact district queue migration SQL executes all RPCs as service_role, denies anon/authenticated, and preserves operator decisions", async () => {
  const db = await database();
  try {
    const queueId = await upsert(db, payload());
    const pending = await db.query<{
      status: string; suggested_district: string; suggestion_source: string; suggestion_evidence: string;
      assigned_district: string | null; raw_payload: Record<string, unknown>;
    }>(`select status,suggested_district,suggestion_source,suggestion_evidence,assigned_district,raw_payload
          from public.price_radar_district_queue where id=$1`, [queueId]);
    assert.deepEqual(pending.rows[0], {
      status: "pending", suggested_district: "Bałuty", suggestion_source: "ai",
      suggestion_evidence: "Opis zawiera nazwę Teofilów.", assigned_district: null,
      raw_payload: { imageUrls: ["https://images.example.test/a.jpg"], sourceProof: "Teofilów" },
    });

    await assert.rejects(
      db.query(`select public.assign_price_radar_district_queue_candidate($1::uuid,$2::uuid,'Łanowa',$1::uuid,$3::jsonb)`, [
        OWNER, queueId, JSON.stringify({ building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", price_per_sqm: 419000 / 45 }),
      ]),
      (error: unknown) => error instanceof Error && /INVALID_DISTRICT/u.test(error.message),
      "the SQL function accepts only the five configured districts, not a street/subarea or arbitrary text",
    );

    const assigned = await asRole(db, "service_role", () =>
      db.query<{ id: string }>(
        `select public.assign_price_radar_district_queue_candidate(
          $1::uuid,$2::uuid,'Bałuty',$1::uuid,$3::jsonb
        ) as id`,
        [OWNER, queueId, JSON.stringify({ building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", price_per_sqm: 419000 / 45 })],
      ));
    const listingId = assigned.rows[0]!.id;
    const createdListing = await db.query<{ district: string; source: string; external_listing_id: string; price: string; excluded_at: string | null }>(
      `select district,source,external_listing_id,price::text,excluded_at::text from public.price_radar_listings where id=$1`, [listingId]);
    assert.deepEqual(createdListing.rows[0], { district: "Bałuty", source: "domiporta", external_listing_id: "portal-123", price: "419000", excluded_at: null });

    const assignedQueue = await db.query<{ status: string; assigned_district: string; assigned_by: string; radar_listing_id: string }>(
      `select status,assigned_district,assigned_by,radar_listing_id from public.price_radar_district_queue where id=$1`, [queueId]);
    assert.deepEqual(assignedQueue.rows[0], { status: "assigned", assigned_district: "Bałuty", assigned_by: OWNER, radar_listing_id: listingId });

    // An operator's exclusion on the linked Radar offer survives a later
    // queue reimport and a district correction.
    await db.query(
      `update public.price_radar_listings set excluded_at='2026-10-11T11:00:00Z', excluded_reason='manual test exclusion' where id=$1`,
      [listingId],
    );

    // A later portal reimport may refresh the offer snapshot and AI evidence,
    // but must not reopen or erase the operator's assignment.
    const reimportedId = await upsert(db, payload({
      title: "Mieszkanie po remoncie — aktualizacja",
      price: 425000,
      price_per_sqm: 425000 / 45,
      content_hash: "district-queue-content-v2",
      collected_at: "2026-10-11T12:00:00.000Z",
      last_seen_at: "2026-10-11T12:00:00.000Z",
      suggested_district: "Polesie",
      suggestion_evidence: "Nowa treść potwierdza okolicę.",
      raw_payload: { imageUrls: ["https://images.example.test/b.jpg"], sourceProof: "updated" },
    }));
    assert.equal(reimportedId, queueId, "the same owner/source/external ID remains one queue row");
    const afterReimport = await db.query<{
      count: number; status: string; assigned_district: string; assigned_by: string; assigned_at: string;
      radar_listing_id: string; price: string; content_hash: string;
    }>(`select count(*) over()::int as count,status,assigned_district,assigned_by,assigned_at::text,radar_listing_id,price::text,content_hash
          from public.price_radar_district_queue where id=$1`, [queueId]);
    assert.equal(afterReimport.rows.length, 1);
    assert.equal(afterReimport.rows[0]!.count, 1);
    assert.deepEqual({
      status: afterReimport.rows[0]!.status,
      assigned_district: afterReimport.rows[0]!.assigned_district,
      assigned_by: afterReimport.rows[0]!.assigned_by,
      radar_listing_id: afterReimport.rows[0]!.radar_listing_id,
      price: afterReimport.rows[0]!.price,
      content_hash: afterReimport.rows[0]!.content_hash,
    }, { status: "assigned", assigned_district: "Bałuty", assigned_by: OWNER, radar_listing_id: listingId, price: "425000", content_hash: "district-queue-content-v2" });
    assert.ok(afterReimport.rows[0]!.assigned_at, "the original operator decision timestamp survives reimport");
    const exclusionAfterReimport = await db.query<{ excluded_epoch: number; excluded_reason: string | null }>(
      `select extract(epoch from excluded_at)::int as excluded_epoch,excluded_reason from public.price_radar_listings where id=$1`, [listingId]);
    assert.deepEqual(exclusionAfterReimport.rows[0], {
      excluded_epoch: Math.floor(Date.parse("2026-10-11T11:00:00Z") / 1000),
      excluded_reason: "manual test exclusion",
    }, "reimporting the queue candidate does not touch the linked listing exclusion");

    // Reassigning a still-qualified candidate is a correction of the same
    // canonical row, not a second Radar listing.
    const corrected = await asRole(db, "service_role", () => db.query<{ id: string }>(
        `select public.assign_price_radar_district_queue_candidate(
          $1::uuid,$2::uuid,'Widzew',$1::uuid,$3::jsonb
        ) as id`,
        [OWNER, queueId, JSON.stringify({ building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", price_per_sqm: 425000 / 45 })],
      ));
    assert.equal(corrected.rows[0]!.id, listingId);
    const finalState = await db.query<{ district: string; count: number }>(
      `select district,count(*) over()::int as count from public.price_radar_listings where owner_id=$1 and source='domiporta' and external_listing_id='portal-123'`, [OWNER]);
    assert.deepEqual(finalState.rows, [{ district: "Widzew", count: 1 }]);
    const exclusionAfterCorrection = await db.query<{ excluded_epoch: number; excluded_reason: string | null }>(
      `select extract(epoch from excluded_at)::int as excluded_epoch,excluded_reason from public.price_radar_listings where id=$1`, [listingId]);
    assert.deepEqual(exclusionAfterCorrection.rows[0], exclusionAfterReimport.rows[0],
      "correcting an assignment updates the same listing without clearing a manual exclusion");

    const rejectedId = await upsert(db, payload({ external_listing_id: "portal-rejected", content_hash: "rejected-candidate" }));
    const rejected = await asRole(db, "service_role", () => db.query<{ updated: boolean }>(
      `select public.set_price_radar_district_queue_rejection($1::uuid,$2::uuid,true) as updated`, [OWNER, rejectedId]));
    assert.equal(rejected.rows[0]!.updated, true);
    const rejectedState = await db.query<{ status: string; rejected_at: string | null }>(
      `select status,rejected_at::text from public.price_radar_district_queue where id=$1`, [rejectedId]);
    assert.equal(rejectedState.rows[0]!.status, "rejected");
    assert.ok(rejectedState.rows[0]!.rejected_at);
    const restored = await asRole(db, "service_role", () => db.query<{ updated: boolean }>(
      `select public.set_price_radar_district_queue_rejection($1::uuid,$2::uuid,false) as updated`, [OWNER, rejectedId]));
    assert.equal(restored.rows[0]!.updated, true, "an operator can restore a rejected, never-assigned candidate to pending");
    const restoredState = await db.query<{ status: string; rejected_at: string | null }>(
      `select status,rejected_at::text from public.price_radar_district_queue where id=$1`, [rejectedId]);
    assert.deepEqual(restoredState.rows[0], { status: "pending", rejected_at: null });

    const privileges = await db.query<{
      table_rls: boolean; anon_select: boolean; auth_select: boolean; service_select: boolean;
      upsert_service: boolean; upsert_anon: boolean; upsert_auth: boolean;
      assign_service: boolean; assign_anon: boolean; assign_auth: boolean;
      reject_service: boolean; reject_anon: boolean; reject_auth: boolean;
    }>(`
      select c.relrowsecurity as table_rls,
        has_table_privilege('anon','public.price_radar_district_queue','SELECT') as anon_select,
        has_table_privilege('authenticated','public.price_radar_district_queue','SELECT') as auth_select,
        has_table_privilege('service_role','public.price_radar_district_queue','SELECT') as service_select,
        has_function_privilege('service_role','public.upsert_price_radar_district_queue_candidate(uuid,jsonb)','EXECUTE') as upsert_service,
        has_function_privilege('anon','public.upsert_price_radar_district_queue_candidate(uuid,jsonb)','EXECUTE') as upsert_anon,
        has_function_privilege('authenticated','public.upsert_price_radar_district_queue_candidate(uuid,jsonb)','EXECUTE') as upsert_auth,
        has_function_privilege('service_role','public.assign_price_radar_district_queue_candidate(uuid,uuid,text,uuid,jsonb)','EXECUTE') as assign_service,
        has_function_privilege('anon','public.assign_price_radar_district_queue_candidate(uuid,uuid,text,uuid,jsonb)','EXECUTE') as assign_anon,
        has_function_privilege('authenticated','public.assign_price_radar_district_queue_candidate(uuid,uuid,text,uuid,jsonb)','EXECUTE') as assign_auth,
        has_function_privilege('service_role','public.set_price_radar_district_queue_rejection(uuid,uuid,boolean)','EXECUTE') as reject_service,
        has_function_privilege('anon','public.set_price_radar_district_queue_rejection(uuid,uuid,boolean)','EXECUTE') as reject_anon,
        has_function_privilege('authenticated','public.set_price_radar_district_queue_rejection(uuid,uuid,boolean)','EXECUTE') as reject_auth
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname='price_radar_district_queue'`);
    assert.deepEqual(privileges.rows[0], {
      table_rls: true, anon_select: false, auth_select: true, service_select: true,
      upsert_service: true, upsert_anon: false, upsert_auth: false,
      assign_service: true, assign_anon: false, assign_auth: false,
      reject_service: true, reject_anon: false, reject_auth: false,
    });

    const upsertRpc = `select public.upsert_price_radar_district_queue_candidate($1::uuid,$2::jsonb)`;
    const assignRpc = `select public.assign_price_radar_district_queue_candidate($1::uuid,$2::uuid,'Górna',$1::uuid,$3::jsonb)`;
    const rejectRpc = `select public.set_price_radar_district_queue_rejection($1::uuid,$2::uuid,true)`;
    const rpcArguments = [OWNER, JSON.stringify(payload())];
    for (const role of ["anon", "authenticated"] as const) {
      await assertRpcDenied(db, role, upsertRpc, rpcArguments);
      await assertRpcDenied(db, role, assignRpc, [OWNER, queueId, JSON.stringify({ building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", price_per_sqm: 419000 / 45 })]);
      await assertRpcDenied(db, role, rejectRpc, [OWNER, rejectedId]);
    }
    const policies = await db.query<{ policyname: string; qual: string | null }>(
      `select policyname,qual from pg_policies where schemaname='public' and tablename='price_radar_district_queue'`);
    assert.deepEqual(policies.rows, [{ policyname: "price_radar_district_queue_owner_select", qual: "(owner_id = ( SELECT auth.uid() AS uid))" }]);
  } finally {
    await db.close();
  }
});
