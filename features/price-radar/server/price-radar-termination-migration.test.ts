import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const BASE = path.join(process.cwd(), "supabase/migrations/20261008000000_create_price_radar.sql");
const STOP = path.join(process.cwd(), "supabase/migrations/20261012110000_add_price_radar_stop_resume.sql");
const STOP_FIX = path.join(process.cwd(), "supabase/migrations/20261012120000_fix_price_radar_stop_without_current_source.sql");
const TERMINATION = path.join(process.cwd(), "supabase/migrations/20261011183209_add_terminal_price_radar_run_end.sql");
const OWNER = "00000000-0000-4000-8000-000000000071";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000072";
const JOB_TOKEN = "00000000-0000-4000-8000-000000000091";
const WORKER = "radar-termination-test-worker";

async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    insert into auth.users (id) values ('${OWNER}'), ('${OTHER_OWNER}');
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
  await db.exec(fs.readFileSync(STOP, "utf8"));
  await db.exec(fs.readFileSync(STOP_FIX, "utf8"));
  // Execute the exact local draft under review, not a copied SQL fragment.
  await db.exec(fs.readFileSync(TERMINATION, "utf8"));
  return db;
}

async function claim(db: PGlite, owner: string, source: string) {
  const checkpoint = {
    sourceQueue: [source], currentSourceIndex: 0, perSourceCursor: { [source]: { page: 2, candidateIndex: 4 } },
    sourceStatuses: { [source]: "running" }, sourceErrors: {}, buffer: [], bufferOffset: 0,
  };
  const result = await db.query<{ run_id: string; lease_token: string }>(
    `select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [owner, JSON.stringify(checkpoint)],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

function listing(source: string, id: string) {
  return {
    source, external_listing_id: id, original_url: `https://example.test/${id}`, normalized_url: `https://example.test/${id}`,
    title: "Mieszkanie", description: "Zachowane źródłowe dane", price: 400000, area: 50, price_per_sqm: 8000,
    rooms: 2, city: "Łódź", district: "Bałuty", building_type: "blok", market_type: "secondary",
    renovation_status: "fresh_renovation", content_hash: `hash-${id}`, published_at: null, source_updated_at: null,
    cross_source_identity: null, collected_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), raw_payload: { evidence: "kept" },
  };
}

async function insertRadarOlxJob(db: PGlite, owner: string, runId: string, radarToken: string, keySuffix: string) {
  return db.query<{ id: string }>(`insert into public.olx_scan_jobs(
    scan_run_id,source_scan_id,search_filter_id,context_type,radar_owner_id,radar_run_id,radar_lease_token,
    request_url,filter_snapshot,idempotency_key,status,lease_token,leased_until,heartbeat_at,worker_id,attempts,result_summary
  ) values ($1,null,null,'price_radar',$2,$1,$3,'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/','{}',$4,'running',$5,now()+interval '120 seconds',now(),$6,1,'{"priorResult":"preserve"}') returning id`,
  [runId, owner, radarToken, `price-radar:${owner}:olx:${keySuffix}`, JOB_TOKEN, WORKER]);
}

test("terminal end is owner-scoped, idempotent, independent of the queue pointer, and preserves saved Radar data", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "domiporta");
    const savedListing = await db.query<{ id: string }>(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb) as id`,
      [OWNER, run.run_id, run.lease_token, JSON.stringify(listing("domiporta", "saved-before-end"))]);
    const queue = ["morizon", "domiporta", "oferty_net"];
    const statuses = { morizon: "completed", domiporta: "running", oferty_net: "pending" };
    const checkpoint = {
      sourceQueue: queue, currentSourceIndex: queue.length, sourceStatuses: statuses,
      perSourceCursor: { morizon: "__RADAR_SOURCE_DONE__", domiporta: { kind: "radar_detail_v1", page: 4, candidateIndex: 12 }, oferty_net: { kind: "radar_detail_v1", page: 2, candidateIndex: 0 } },
      sourceErrors: { old_source: "preserve this diagnostic" }, sourceWarnings: { morizon: ["preserve warning"] },
      detailDiagnostics: { oferty_net: [{ listingUrl: "https://oferty.net/of,123" }] }, buffer: [], bufferOffset: 0,
    };
    await db.query(`update public.price_radar_runs set checkpoint=$2::jsonb, source_statuses=$3::jsonb,
      scanned_count=77,qualified_count=3,lease_until=now()+interval '60 seconds' where id=$1`,
    [run.run_id, JSON.stringify(checkpoint), JSON.stringify(statuses)]);

    const wrongOwner = await db.query<{ result: string }>(`select public.terminate_price_radar_run($1::uuid,$2::uuid) as result`, [OTHER_OWNER, run.run_id]);
    assert.equal(wrongOwner.rows[0].result, "run_changed", "another operator cannot terminate this run");
    const ended = await db.query<{ result: string }>(`select public.terminate_price_radar_run($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(ended.rows[0].result, "terminated", "the run-row operation succeeds even when currentSourceIndex equals queue.length and sources remain pending");
    const repeated = await db.query<{ result: string }>(`select public.terminate_price_radar_run($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(repeated.rows[0].result, "terminated", "the terminal request is idempotent");

    const row = await db.query<{ status: string; user_terminated_at: string | null; finished_at: string | null; lease_token: string | null; lease_until: string | null; scanned_count: number; qualified_count: number; checkpoint: Record<string, unknown>; source_statuses: Record<string, string> }>(
      `select status,user_terminated_at,finished_at,lease_token,lease_until,scanned_count,qualified_count,checkpoint,source_statuses from public.price_radar_runs where id=$1`, [run.run_id]);
    const saved = row.rows[0]!;
    assert.equal(saved.status, "partial", "existing DB status values remain compatible; user_terminated_at makes this partial terminal and non-resumable");
    assert.ok(saved.user_terminated_at);
    assert.equal(Date.parse(String(saved.finished_at)), Date.parse(String(saved.user_terminated_at)));
    assert.equal(saved.lease_token, null);
    assert.equal(saved.lease_until, null);
    assert.equal(saved.scanned_count, 77);
    assert.equal(saved.qualified_count, 3);
    assert.equal(saved.checkpoint.currentSourceIndex, queue.length, "the saved queue pointer is unchanged");
    assert.deepEqual(saved.checkpoint.perSourceCursor, checkpoint.perSourceCursor, "all portal cursors are retained");
    assert.deepEqual(saved.checkpoint.sourceErrors, checkpoint.sourceErrors, "source diagnostics are retained");
    assert.deepEqual(saved.checkpoint.sourceWarnings, checkpoint.sourceWarnings);
    assert.deepEqual(saved.checkpoint.detailDiagnostics, checkpoint.detailDiagnostics);
    assert.deepEqual(saved.checkpoint.sourceStatuses, { morizon: "completed", domiporta: "pending", oferty_net: "pending" });
    assert.deepEqual(saved.source_statuses, saved.checkpoint.sourceStatuses, "the only source-state change is running to pending; unfinished sources are not marked completed");
    const retained = await db.query<{ count: number }>(`select count(*)::int as count from public.price_radar_listings where id=$1`, [savedListing.rows[0]!.id]);
    assert.equal(retained.rows[0]?.count, 1, "previously persisted Radar listings are not deleted or rewritten");

    const staleCheckpoint = await db.query<{ accepted: boolean }>(`select public.checkpoint_price_radar_run(
      $1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,78,4,'running',null,120) as accepted`,
    [OWNER, run.run_id, run.lease_token, JSON.stringify({ ...checkpoint, currentSourceIndex: 2 }), JSON.stringify(statuses)]);
    assert.equal(staleCheckpoint.rows[0].accepted, false, "a late checkpoint cannot revive or overwrite a terminal run");
    await assert.rejects(
      db.query(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb)`, [OWNER, run.run_id, run.lease_token, JSON.stringify(listing("domiporta", "late-listing"))]),
      /RADAR_LEASE_LOST/u,
      "a stale source worker cannot persist after the terminal transaction commits",
    );
    const nextRun = await claim(db, OWNER, "domiporta");
    assert.notEqual(nextRun.run_id, run.run_id, "a later permitted claim creates a new scan_run_id instead of resuming the ended ID");
    const oldCount = await db.query<{ count: number }>(`select count(*)::int as count from public.price_radar_runs where id=$1`, [run.run_id]);
    assert.equal(oldCount.rows[0]?.count, 1, "the old terminal run remains in history");
  } finally {
    await db.close();
  }
});

test("a stopped run may be permanently ended; OLX finalizers and heartbeat are fenced without touching other jobs", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "olx");
    const otherRun = await claim(db, OTHER_OWNER, "olx");
    const job = await insertRadarOlxJob(db, OWNER, run.run_id, run.lease_token, run.run_id);
    const otherJob = await insertRadarOlxJob(db, OTHER_OWNER, otherRun.run_id, otherRun.lease_token, otherRun.run_id);
    const finderJob = await db.query<{ id: string }>(`insert into public.olx_scan_jobs(
      scan_run_id,source_scan_id,search_filter_id,context_type,request_url,filter_snapshot,idempotency_key,
      status,lease_token,leased_until,heartbeat_at,worker_id,attempts
    ) values ($1,$2,$3,'finder','https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/','{}','finder-job-survives','running',$4,
      now()+interval '120 seconds',now(),'finder-worker',1) returning id`, [OWNER, run.run_id, run.run_id, JOB_TOKEN]);

    const paused = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(paused.rows[0].result, "stopping");
    const ended = await db.query<{ result: string }>(`select public.terminate_price_radar_run($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(ended.rows[0].result, "terminated", "the same stopped run can be permanently ended");
    const row = await db.query<{ status: string; user_terminated_at: string | null; checkpoint: Record<string, unknown> }>(`select status,user_terminated_at,checkpoint from public.price_radar_runs where id=$1`, [run.run_id]);
    assert.equal(row.rows[0]?.status, "partial");
    assert.ok(row.rows[0]?.user_terminated_at);
    assert.equal((row.rows[0]?.checkpoint.sourceStatuses as Record<string, string>).olx, "pending", "OLX is left unfinished");

    const canceled = await db.query<{ status: string; error_code: string; lease_token: string | null; result_summary: Record<string, unknown> }>(`select status,error_code,lease_token,result_summary from public.olx_scan_jobs where id=$1`, [job.rows[0]!.id]);
    assert.equal(canceled.rows[0]?.status, "failed");
    assert.equal(canceled.rows[0]?.error_code, "RADAR_TERMINATED_BY_USER");
    assert.equal(canceled.rows[0]?.lease_token, null, "the exact Radar OLX job is fenced");
    assert.equal(canceled.rows[0]?.result_summary.priorResult, "preserve", "the queue history summary is retained");
    assert.equal(canceled.rows[0]?.result_summary.termination_reason, "user_request");

    const unrelated = await db.query<{ status: string; lease_token: string | null }>(`select status,lease_token from public.olx_scan_jobs where id=$1`, [otherJob.rows[0]!.id]);
    assert.equal(unrelated.rows[0]?.status, "running", "another owner's Radar queue job is untouched");
    assert.equal(unrelated.rows[0]?.lease_token, JOB_TOKEN);
    const finder = await db.query<{ status: string; lease_token: string | null }>(`select status,lease_token from public.olx_scan_jobs where id=$1`, [finderJob.rows[0]!.id]);
    assert.equal(finder.rows[0]?.status, "running", "a Finder OLX job is outside this operation");
    assert.equal(finder.rows[0]?.lease_token, JOB_TOKEN);

    const heartbeat = await db.query<{ accepted: boolean }>(`select public.heartbeat_price_radar_olx_job($1::uuid,$2::text,$3::uuid,$4::uuid,120) as accepted`,
      [job.rows[0]!.id, WORKER, JOB_TOKEN, run.lease_token]);
    assert.equal(heartbeat.rows[0]?.accepted, false, "a stale OLX heartbeat cannot restore the job or run");
    const olxCheckpoint = { sourceQueue: ["olx"], currentSourceIndex: 1, sourceStatuses: { olx: "completed" }, sourceErrors: {}, perSourceCursor: { olx: "__RADAR_SOURCE_DONE__" }, buffer: [], bufferOffset: 0 };
    const finalizer = await db.query<{ accepted: boolean }>(`select public.finalize_price_radar_olx_job(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::uuid,$7::jsonb,$8::jsonb,999,99,'completed',null,
      'completed','{"late":true}',null,null) as accepted`,
    [OWNER, run.run_id, run.lease_token, job.rows[0]!.id, WORKER, JOB_TOKEN, JSON.stringify(olxCheckpoint), JSON.stringify(olxCheckpoint.sourceStatuses)]);
    assert.equal(finalizer.rows[0]?.accepted, false, "late OLX finalization cannot mutate a terminal run");
    const unchanged = await db.query<{ status: string; user_terminated_at: string | null; scanned_count: number; qualified_count: number }>(`select status,user_terminated_at,scanned_count,qualified_count from public.price_radar_runs where id=$1`, [run.run_id]);
    assert.deepEqual(unchanged.rows[0], { status: "partial", user_terminated_at: row.rows[0]?.user_terminated_at, scanned_count: 0, qualified_count: 0 });
  } finally {
    await db.close();
  }
});

test("termination works for a stopped run at queue end and RPC access remains service_role-only", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "morizon");
    const statuses = { morizon: "completed", oferty_net: "pending" };
    const checkpoint = { sourceQueue: ["morizon", "oferty_net"], currentSourceIndex: 2, sourceStatuses: statuses, perSourceCursor: { morizon: "__RADAR_SOURCE_DONE__", oferty_net: { page: 3, candidateIndex: 8 } }, sourceErrors: {}, buffer: [], bufferOffset: 0 };
    await db.query(`update public.price_radar_runs set checkpoint=$2::jsonb,source_statuses=$3::jsonb,stop_requested_at=now(),
      status='partial',error_message='RADAR_STOPPED_BY_OPERATOR',lease_token=null,lease_until=null,finished_at=now() where id=$1`,
    [run.run_id, JSON.stringify(checkpoint), JSON.stringify(statuses)]);
    const ended = await db.query<{ result: string }>(`select public.terminate_price_radar_run($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(ended.rows[0]?.result, "terminated");
    const saved = await db.query<{ status: string; checkpoint: Record<string, unknown>; user_terminated_at: string | null }>(`select status,checkpoint,user_terminated_at from public.price_radar_runs where id=$1`, [run.run_id]);
    assert.equal(saved.rows[0]?.status, "partial");
    assert.ok(saved.rows[0]?.user_terminated_at);
    assert.equal(saved.rows[0]?.checkpoint.currentSourceIndex, 2);
    assert.deepEqual(saved.rows[0]?.checkpoint.perSourceCursor, checkpoint.perSourceCursor);
    assert.equal((saved.rows[0]?.checkpoint.sourceStatuses as Record<string, string>).oferty_net, "pending");

    const privileges = await db.query<{ anon_exec: boolean; authenticated_exec: boolean; service_exec: boolean; definer: boolean; config: string[] | null }>(`
      select has_function_privilege('anon','public.terminate_price_radar_run(uuid,uuid)','EXECUTE') as anon_exec,
             has_function_privilege('authenticated','public.terminate_price_radar_run(uuid,uuid)','EXECUTE') as authenticated_exec,
             has_function_privilege('service_role','public.terminate_price_radar_run(uuid,uuid)','EXECUTE') as service_exec,
             p.prosecdef as definer, p.proconfig as config
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='terminate_price_radar_run'`);
    assert.deepEqual(privileges.rows[0], { anon_exec: false, authenticated_exec: false, service_exec: true, definer: true, config: ["search_path=\"\""] });
  } finally {
    await db.close();
  }
});
