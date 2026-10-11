import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

const BASE = path.join(process.cwd(), "supabase/migrations/20261008000000_create_price_radar.sql");
const DRAFT = path.join(process.cwd(), "supabase/migrations/20261012110000_add_price_radar_stop_resume.sql");
const OWNER = "00000000-0000-4000-8000-000000000071";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000072";
const JOB_TOKEN = "00000000-0000-4000-8000-000000000091";
const WORKER = "radar-stop-test-worker";
const STOP = "RADAR_STOPPED_BY_OPERATOR";

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
  await db.exec(fs.readFileSync(DRAFT, "utf8"));
  return db;
}

function checkpoint(source: string) {
  return {
    sourceQueue: [source], currentSourceIndex: 0, perSourceCursor: { [source]: { page: 2, candidateIndex: 4 } },
    sourceStatuses: { [source]: "running" }, sourceErrors: {}, buffer: [], bufferOffset: 0,
  };
}

async function claim(db: PGlite, owner: string, source: string) {
  const result = await db.query<{ run_id: string; lease_token: string }>(
    `select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [owner, JSON.stringify(checkpoint(source))],
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

test("stop RPC owner-scopes, preserves cursor, and fences persistence and ordinary checkpoints", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "domiporta");
    const wrongOwner = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OTHER_OWNER, run.run_id]);
    assert.equal(wrongOwner.rows[0].result, "run_changed");

    const requested = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(requested.rows[0].result, "stopping", "a live worker receives a durable stop request without waiting for lease expiry");
    const beforeAck = await db.query<{ status: string; source_statuses: Record<string, string>; stop_requested_at: string; checkpoint: Record<string, unknown> }>(
      `select status,source_statuses,stop_requested_at,checkpoint from price_radar_runs where id=$1`, [run.run_id],
    );
    assert.equal(beforeAck.rows[0].status, "running");
    assert.ok(beforeAck.rows[0].stop_requested_at, "the durable stop timestamp is stored while the active worker acknowledges it");
    assert.equal((beforeAck.rows[0].checkpoint.sourceStatuses as Record<string, string>).domiporta, "running", "UI source state remains truthful until worker acknowledgment");
    assert.deepEqual(beforeAck.rows[0].checkpoint.perSourceCursor, { domiporta: { page: 2, candidateIndex: 4 } });

    const candidate = {
      source: "domiporta", external_listing_id: "stop-candidate", original_url: "https://domiporta.example/stop-candidate",
      normalized_url: "https://domiporta.example/stop-candidate", title: "Mieszkanie", description: "Fixture",
      price: 400000, area: 50, price_per_sqm: 8000, rooms: 2, city: "Łódź", district: "Bałuty",
      building_type: "blok", market_type: "secondary", renovation_status: "fresh_renovation", content_hash: "stop-hash",
      published_at: null, source_updated_at: null, cross_source_identity: null,
      collected_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), raw_payload: {},
    };
    await assert.rejects(
      db.query(`select public.persist_price_radar_listing($1::uuid,$2::uuid,$3::uuid,$4::jsonb)`, [OWNER, run.run_id, run.lease_token, JSON.stringify(candidate)]),
      (error: unknown) => error instanceof Error && /RADAR_LEASE_LOST/.test(error.message),
      "once STOP commits, a stale portion cannot persist another Radar listing",
    );
    const ordinaryCheckpoint = await db.query<{ accepted: boolean }>(
      `select public.checkpoint_price_radar_run($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,7,0,'running',null,120) as accepted`,
      [OWNER, run.run_id, run.lease_token, JSON.stringify(checkpoint("domiporta")), JSON.stringify({ domiporta: "running" })],
    );
    assert.equal(ordinaryCheckpoint.rows[0].accepted, false, "a stale worker cannot overwrite the stop request with a running checkpoint");

    const stoppedCheckpoint = { ...checkpoint("domiporta"), sourceStatuses: { domiporta: "pending" } };
    const acknowledged = await db.query<{ accepted: boolean }>(
      `select public.checkpoint_price_radar_run($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::jsonb,7,0,'partial',$6,120) as accepted`,
      [OWNER, run.run_id, run.lease_token, JSON.stringify(stoppedCheckpoint), JSON.stringify(stoppedCheckpoint.sourceStatuses), STOP],
    );
    assert.equal(acknowledged.rows[0].accepted, true);
    const saved = await db.query<{ status: string; error_message: string; lease_token: string | null; scanned_count: number; checkpoint: Record<string, unknown> }>(
      `select status,error_message,lease_token,scanned_count,checkpoint from price_radar_runs where id=$1`, [run.run_id],
    );
    assert.deepEqual({ status: saved.rows[0].status, error_message: saved.rows[0].error_message, lease_token: saved.rows[0].lease_token, scanned_count: saved.rows[0].scanned_count },
      { status: "partial", error_message: STOP, lease_token: null, scanned_count: 7 });
    assert.deepEqual(saved.rows[0].checkpoint.perSourceCursor, { domiporta: { page: 2, candidateIndex: 4 } }, "the same run retains its exact committed source cursor");
    const rows = await db.query<{ count: number }>(`select count(*)::int as count from price_radar_listings where owner_id=$1`, [OWNER]);
    assert.equal(rows.rows[0].count, 0);
    const privilege = await db.query<{ anon_exec: boolean; authenticated_exec: boolean; service_exec: boolean; persist_service: boolean }>(`
      select has_function_privilege('anon','public.request_price_radar_run_stop(uuid,uuid)','EXECUTE') as anon_exec,
             has_function_privilege('authenticated','public.request_price_radar_run_stop(uuid,uuid)','EXECUTE') as authenticated_exec,
             has_function_privilege('service_role','public.request_price_radar_run_stop(uuid,uuid)','EXECUTE') as service_exec,
             has_function_privilege('service_role','public.persist_price_radar_listing(uuid,uuid,uuid,jsonb)','EXECUTE') as persist_service`);
    assert.deepEqual(privilege.rows[0], { anon_exec: false, authenticated_exec: false, service_exec: true, persist_service: true });
    const functionSecurity = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; anon_exec: boolean; authenticated_exec: boolean; service_exec: boolean }>(`
      select p.proname,p.prosecdef,p.proconfig,
             has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,
             has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_exec,
             has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname in (
         'claim_price_radar_run','request_price_radar_run_stop','persist_price_radar_listing',
         'checkpoint_price_radar_run','heartbeat_price_radar_olx_job','finalize_price_radar_olx_job'
       ) order by p.proname`);
    assert.equal(functionSecurity.rows.length, 6);
    for (const fn of functionSecurity.rows) {
      assert.equal(fn.prosecdef, true, `${fn.proname} remains SECURITY DEFINER`);
      assert.ok(fn.proconfig?.some((setting) => setting.replace(/\s/g, "") === "search_path=public"), `${fn.proname} pins search_path to public`);
      assert.equal(fn.anon_exec, false, `${fn.proname} is not executable by anon`);
      assert.equal(fn.authenticated_exec, false, `${fn.proname} is not executable by authenticated`);
      assert.equal(fn.service_exec, true, `${fn.proname} remains executable by service_role`);
    }
  } finally {
    await db.close();
  }
});

test("an expired run is finalized as stopped instead of leaving a blocking lease", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "oferty_net");
    await db.query(`update price_radar_runs set lease_until=now()-interval '1 second' where id=$1`, [run.run_id]);
    const stopped = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(stopped.rows[0].result, "stopped");
    const row = await db.query<{ status: string; lease_token: string | null; lease_until: string | null; source_statuses: Record<string, string>; checkpoint: Record<string, unknown> }>(
      `select status,lease_token,lease_until,source_statuses,checkpoint from price_radar_runs where id=$1`, [run.run_id],
    );
    assert.equal(row.rows[0].status, "partial");
    assert.equal(row.rows[0].lease_token, null);
    assert.equal(row.rows[0].lease_until, null);
    assert.equal((row.rows[0].checkpoint.sourceStatuses as Record<string, string>).oferty_net, "pending");
    const repeated = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(repeated.rows[0].result, "stopped", "repeated stop is idempotent after acknowledgment");
  } finally {
    await db.close();
  }
});

test("a queued OLX reservation is failed only for the stopped run and its same row is resumable", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "olx");
    const job = await db.query<{ id: string }>(`insert into olx_scan_jobs(
      scan_run_id,source_scan_id,search_filter_id,context_type,radar_owner_id,radar_run_id,radar_lease_token,
      request_url,filter_snapshot,idempotency_key,status
    ) values ($1,null,null,'price_radar',$2,$1,$3,'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/','{}',$4,'queued') returning id`,
    [run.run_id, OWNER, run.lease_token, `price-radar:${OWNER}:olx:${run.run_id}`]);
    const stopped = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(stopped.rows[0].result, "stopped", "a queued job has no worker to acknowledge STOP");
    const jobState = await db.query<{ id: string; status: string; error_code: string; radar_lease_token: string }>(`select id,status,error_code,radar_lease_token from olx_scan_jobs where id=$1`, [job.rows[0].id]);
    assert.deepEqual(jobState.rows[0], { id: job.rows[0].id, status: "failed", error_code: STOP, radar_lease_token: run.lease_token });
    const count = await db.query<{ count: number }>(`select count(*)::int as count from olx_scan_jobs where idempotency_key=$1`, [`price-radar:${OWNER}:olx:${run.run_id}`]);
    assert.equal(count.rows[0].count, 1, "stopping does not create another OLX queue row");
  } finally {
    await db.close();
  }
});

test("a late OLX success finalizer cannot overwrite an accepted STOP or mark its source completed", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "olx");
    const job = await db.query<{ id: string }>(`insert into olx_scan_jobs(
      scan_run_id,source_scan_id,search_filter_id,context_type,radar_owner_id,radar_run_id,radar_lease_token,
      request_url,filter_snapshot,idempotency_key,status,lease_token,leased_until,heartbeat_at,worker_id,attempts
    ) values ($1,null,null,'price_radar',$2,$1,$3,'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/','{}',$4,'running',$5,now()+interval '120 seconds',now(),$6,1) returning id`,
    [run.run_id, OWNER, run.lease_token, `price-radar:${OWNER}:olx:${run.run_id}`, JOB_TOKEN, WORKER]);
    const requested = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(requested.rows[0].result, "stopping");
    const completedCheckpoint = { ...checkpoint("olx"), currentSourceIndex: 1, sourceStatuses: { olx: "completed" } };
    const lateFinalize = await db.query<{ accepted: boolean }>(`select public.finalize_price_radar_olx_job(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::uuid,$7::jsonb,$8::jsonb,99,8,'completed',null,
      'completed','{}',null,null
    ) as accepted`, [OWNER, run.run_id, run.lease_token, job.rows[0].id, WORKER, JOB_TOKEN,
      JSON.stringify(completedCheckpoint), JSON.stringify(completedCheckpoint.sourceStatuses)]);
    assert.equal(lateFinalize.rows[0].accepted, true, "the DB records the worker's acknowledgment as STOP, not as success");
    const saved = await db.query<{ status: string; error_message: string; scanned_count: number; qualified_count: number; checkpoint: Record<string, unknown> }>(
      `select status,error_message,scanned_count,qualified_count,checkpoint from price_radar_runs where id=$1`, [run.run_id]);
    assert.deepEqual({ status: saved.rows[0].status, error_message: saved.rows[0].error_message }, { status: "partial", error_message: STOP });
    assert.equal((saved.rows[0].checkpoint.sourceStatuses as Record<string, string>).olx, "pending");
    assert.equal(saved.rows[0].checkpoint.currentSourceIndex, 0, "OLX remains at the same resumable source checkpoint");
    assert.equal(saved.rows[0].scanned_count, 99, "only results from the worker's already-finished batch are retained in the run counters");
    assert.equal(saved.rows[0].qualified_count, 8);
    const jobState = await db.query<{ status: string; error_code: string }>(`select status,error_code from olx_scan_jobs where id=$1`, [job.rows[0].id]);
    assert.deepEqual(jobState.rows[0], { status: "failed", error_code: STOP });
    const staleSecondFinalize = await db.query<{ accepted: boolean }>(`select public.finalize_price_radar_olx_job(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::uuid,$7::jsonb,$8::jsonb,100,9,'completed',null,
      'completed','{}',null,null
    ) as accepted`, [OWNER, run.run_id, run.lease_token, job.rows[0].id, WORKER, JOB_TOKEN,
      JSON.stringify(completedCheckpoint), JSON.stringify(completedCheckpoint.sourceStatuses)]);
    assert.equal(staleSecondFinalize.rows[0].accepted, false, "a stale completion cannot mutate the terminal stopped run");
  } finally {
    await db.close();
  }
});

test("an active OLX worker heartbeat acknowledges STOP, fails its exact job, and cannot reclaim automatically", async () => {
  const db = await database();
  try {
    const run = await claim(db, OWNER, "olx");
    const job = await db.query<{ id: string }>(`insert into olx_scan_jobs(
      scan_run_id,source_scan_id,search_filter_id,context_type,radar_owner_id,radar_run_id,radar_lease_token,
      request_url,filter_snapshot,idempotency_key,status,lease_token,leased_until,heartbeat_at,worker_id,attempts
    ) values ($1,null,null,'price_radar',$2,$1,$3,'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/','{}',$4,'running',$5,now()+interval '120 seconds',now(),$6,1) returning id`,
    [run.run_id, OWNER, run.lease_token, `price-radar:${OWNER}:olx:${run.run_id}`, JOB_TOKEN, WORKER]);
    const requested = await db.query<{ result: string }>(`select public.request_price_radar_run_stop($1::uuid,$2::uuid) as result`, [OWNER, run.run_id]);
    assert.equal(requested.rows[0].result, "stopping");
    const competingClaim = await db.query(`select * from public.claim_price_radar_run($1::uuid,$2::jsonb,120)`, [OWNER, JSON.stringify(checkpoint("olx"))]);
    assert.equal(competingClaim.rows.length, 0, "a stop-requested run cannot be silently reclaimed by continuation");
    const heartbeat = await db.query<{ accepted: boolean }>(`select public.heartbeat_price_radar_olx_job($1::uuid,$2::text,$3::uuid,$4::uuid,120) as accepted`, [job.rows[0].id, WORKER, JOB_TOKEN, run.lease_token]);
    assert.equal(heartbeat.rows[0].accepted, false, "the heartbeat reports STOP rather than renewing either lease");
    const state = await db.query<{ status: string; error_message: string; lease_token: string | null; checkpoint: Record<string, unknown> }>(`select status,error_message,lease_token,checkpoint from price_radar_runs where id=$1`, [run.run_id]);
    assert.deepEqual({ status: state.rows[0].status, error_message: state.rows[0].error_message, lease_token: state.rows[0].lease_token }, { status: "partial", error_message: STOP, lease_token: null });
    assert.equal((state.rows[0].checkpoint.sourceStatuses as Record<string, string>).olx, "pending");
    const jobState = await db.query<{ status: string; error_code: string; worker_id: string }>(`select status,error_code,worker_id from olx_scan_jobs where id=$1`, [job.rows[0].id]);
    assert.deepEqual(jobState.rows[0], { status: "failed", error_code: STOP, worker_id: WORKER });
  } finally {
    await db.close();
  }
});
