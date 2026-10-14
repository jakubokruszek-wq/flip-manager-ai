/**
 * The Production case behind the OLX removal (audit of PR #16): Price Radar
 * run 13ac1f61-… is still "running" with an expired lease, and its OLX job
 * 09b4e9b6-… is still queued. Here the REAL collect.ts code runs against the
 * REAL SQL (PGlite with Production's migrations, then PR #16's) through a
 * small PostgREST-like adapter; only the portal fetchers are fakes.
 *
 * Proven: the migration retires the job auditably (nothing deleted, never
 * run); the run is then continued by the automatic path (claim_price_radar_run
 * takes over the expired lease) or by the operator's resume, and finishes
 * without OLX: the OLX stage is closed as RADAR_OLX_REMOVED, the remaining
 * portal runs, the completed one is not fetched again, no OLX job is created
 * and no OLX claim can take the retired job.
 */
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { CHAIN_OWNER, PR16_MIGRATIONS, chainDatabase, migration } from "../../flip-finder/server/olx-migration-chain.fixture.ts";

const RUN = "13ac1f61-ee43-4b5a-af3e-b09b407138ed";
const JOB = "09b4e9b6-eb7f-4a3d-97c3-ad63dd7d6f71";
const OLD_LEASE = "0b0b0b0b-0000-4000-8000-00000000c0de";

type Row = Record<string, unknown>;
const fetched: string[] = [];

mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => { throw new Error("tests pass the PGlite adapter explicitly"); } } });
mock.module("@/features/price-radar/server/radar-district-ai", {
  namedExports: { createRadarDistrictAiBudget: () => ({ tryConsume: () => true }), suggestRadarDistrictWithAi: async () => null },
});
const source = (id: string, label: string) => ({ id, label, fetch: async () => { fetched.push(id); return { listings: [], warnings: [], fetched: 0 }; } });
const sources = [source("domiporta", "Domiporta"), source("morizon", "Morizon"), source("olx", "OLX")];
mock.module("@/features/flip-finder/server/search-source-registry", {
  namedExports: { SOURCES: sources, slugifyCity: () => "lodz", activeSources: (filter: { sources: string[] }) => sources.filter((item) => filter.sources.includes(item.id)) },
});

const { claimOrCreateRadarRun, resumeExistingRadarRun, runRadarCollectionPortion } = await import("./collect.ts");

/** The subset of supabase-js that collect.ts uses, executed as SQL. */
function postgrest(db: PGlite) {
  const plain = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const row = (value: Row) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  const param = (value: unknown) => (value !== null && typeof value === "object" && !(value instanceof Date) ? JSON.stringify(value) : value);
  const failure = (error: unknown) => ({ data: null, error: { code: "P0001", message: error instanceof Error ? error.message : String(error) } });
  return {
    async rpc(name: string, args: Row) {
      const keys = Object.keys(args);
      try {
        const result = await db.query<Row>(`select * from public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")})`, keys.map((key) => param(args[key])));
        if (result.fields.length === 1 && result.fields[0].name === name) return { data: plain(result.rows[0]?.[name] ?? null), error: null };
        return { data: result.rows.map(row), error: null };
      } catch (error) {
        return failure(error);
      }
    },
    from(table: string) {
      const where: Array<(next: (value: unknown) => string) => string> = [];
      let columns = "*";
      let update: Row | null = null;
      const run = async (): Promise<{ data: Row[] | null; error: { code: string; message: string } | null }> => {
        const params: unknown[] = [];
        const next = (value: unknown) => { params.push(param(value)); return `$${params.length}`; };
        const conditions = where.map((condition) => condition(next));
        const clause = conditions.length ? ` where ${conditions.join(" and ")}` : "";
        const sql = update
          ? `update public.${table} set ${Object.keys(update).map((key) => `${key} = ${next(update![key])}`).join(", ")}${clause} returning ${columns}`
          : `select ${columns} from public.${table}${clause}`;
        try {
          return { data: (await db.query<Row>(sql, params)).rows.map(row), error: null };
        } catch (error) {
          return failure(error);
        }
      };
      const builder = {
        select: (selected = "*") => { columns = selected; return builder; },
        update: (values: Row) => { update = values; return builder; },
        eq: (column: string, value: unknown) => { where.push((next) => `${column} = ${next(value)}`); return builder; },
        is: (column: string, value: unknown) => { where.push(() => `${column} is ${value === null ? "null" : String(value)}`); return builder; },
        lte: (column: string, value: unknown) => { where.push((next) => `${column} <= ${next(value)}`); return builder; },
        in: (column: string, values: unknown[]) => { where.push((next) => `${column} in (${values.map(next).join(", ")})`); return builder; },
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => { const result = await run(); return { data: result.data?.[0] ?? null, error: result.error }; },
        single: async () => { const result = await run(); return { data: result.data?.[0] ?? null, error: result.error }; },
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject),
      };
      return builder;
    },
  };
}

/** Production as reported: the run's lease expired hours ago while its OLX stage waited for a queued job. */
async function production(): Promise<PGlite> {
  const db = await chainDatabase([]);
  const checkpoint = {
    sourceQueue: ["domiporta", "olx", "morizon"], currentSourceIndex: 1,
    sourceStatuses: { domiporta: "completed", olx: "running", morizon: "pending" },
    sourceErrors: {}, perSourceCursor: { domiporta: "__RADAR_SOURCE_DONE__" }, qualificationRejections: {}, buffer: [], bufferOffset: 0,
  };
  await db.query(`insert into public.price_radar_runs (id, owner_id, status, started_at, checkpoint, source_statuses, lease_token, lease_until, scanned_count, qualified_count)
    values ($1, $2, 'running', now() - interval '5 hours', $3::jsonb, $4::jsonb, $5, now() - interval '3 hours', 12, 3)`,
  [RUN, CHAIN_OWNER, JSON.stringify(checkpoint), JSON.stringify(checkpoint.sourceStatuses), OLD_LEASE]);
  await db.query(`insert into public.olx_scan_jobs (id, scan_run_id, context_type, radar_owner_id, radar_run_id, radar_lease_token, request_url, idempotency_key, status, created_at)
    values ($1, $2, 'price_radar', $3, $2, $4, 'https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/', $5, 'queued', now() - interval '4 hours')`,
  [JOB, RUN, CHAIN_OWNER, OLD_LEASE, `price-radar:${CHAIN_OWNER}:olx:${RUN}`]);
  return db;
}

async function applyPr16(db: PGlite) {
  for (const file of PR16_MIGRATIONS) await db.exec(migration(file));
}

const theJob = async (db: PGlite) => (await db.query<{ status: string; error_code: string | null; attempts: number; result_summary: Row | null; worker_id: string | null }>(
  `select status, error_code, attempts, result_summary, worker_id from public.olx_scan_jobs where id = $1`, [JOB])).rows[0];

async function finish(db: PGlite, leaseToken: string) {
  const client = postgrest(db);
  let result = await runRadarCollectionPortion({ runId: RUN, ownerId: CHAIN_OWNER, leaseToken }, client as never);
  for (let portion = 0; result.status === "running" && portion < 5; portion += 1) {
    const current = (await db.query<{ lease_token: string }>(`select lease_token from public.price_radar_runs where id = $1`, [RUN])).rows[0];
    result = await runRadarCollectionPortion({ runId: RUN, ownerId: CHAIN_OWNER, leaseToken: current.lease_token }, client as never);
  }
  return result;
}

async function assertFinishedWithoutOlx(db: PGlite, result: Awaited<ReturnType<typeof finish>>) {
  assert.equal(result.status, "partial", "the run ends, honestly partial: its OLX stage was skipped");
  assert.equal(result.sourceStatuses.olx, "failed");
  assert.match(result.sourceErrors.olx ?? "", /^RADAR_OLX_REMOVED:/);
  assert.equal(result.sourceStatuses.morizon, "completed", "the remaining portal runs");
  assert.equal(result.sourceStatuses.domiporta, "completed");
  assert.deepEqual(fetched, ["morizon"], "OLX is never fetched; the completed portal is not fetched again");
  const stored = (await db.query<{ status: string; lease_until: Date | null; finished_at: Date | null }>(`select status, lease_until, finished_at from public.price_radar_runs where id = $1`, [RUN])).rows[0];
  assert.equal(stored.status, "partial");
  assert.ok(stored.finished_at);
  assert.equal((await db.query(`select 1 from public.olx_scan_jobs`)).rows.length, 1, "no OLX job created, the historical one kept");
  const job = await theJob(db);
  assert.deepEqual([job.status, job.error_code, job.attempts, job.worker_id], ["failed", "RADAR_OLX_REMOVED", 0, null], "retired, never run");
  for (const sql of [`select * from public.claim_olx_scan_job('local-worker', 120)`, `select * from public.claim_olx_scan_job_selective('cloudflare-olx-stage2', '${JOB}', 120)`]) {
    assert.equal((await db.query(sql)).rows.length, 0, sql);
  }
}

test("control: in today's Production state the regular worker would still take the old Radar OLX job", async () => {
  const db = await production();
  try {
    const claimed = await db.query<{ id: string }>(`select id from public.claim_olx_scan_job('local-worker', 120)`);
    assert.deepEqual(claimed.rows.map((row) => row.id), [JOB], "why the migrations must follow the merge at once (or the local OLX worker stays off)");
  } finally {
    await db.close();
  }
});

test("the migration retires job 09b4e9b6 auditably without running it; run 13ac1f61 is left for Radar to continue", async () => {
  const db = await production();
  try {
    await applyPr16(db);
    const job = await theJob(db);
    assert.equal(job.status, "failed");
    assert.equal(job.error_code, "RADAR_OLX_REMOVED");
    const audit = (job.result_summary as Row).radarOlxRemoved as Row;
    assert.equal(audit.retiredFromStatus, "queued");
    assert.equal(audit.previousErrorCode, null);
    const run = (await db.query<{ status: string; lease_token: string }>(`select status, lease_token from public.price_radar_runs where id = $1`, [RUN])).rows[0];
    assert.deepEqual(run, { status: "running", lease_token: OLD_LEASE }, "the migration does not touch the run itself");
  } finally {
    await db.close();
  }
});

test("automatic continuation: claim_price_radar_run takes over the expired lease and the run finishes without OLX", async () => {
  const db = await production();
  fetched.length = 0;
  try {
    await applyPr16(db);
    const claimed = await claimOrCreateRadarRun(CHAIN_OWNER, [], postgrest(db) as never);
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;
    assert.equal(claimed.run.id, RUN, "the historical run is continued, no second run");
    assert.notEqual(claimed.run.leaseToken, OLD_LEASE);
    assert.equal((await theJob(db)).status, "failed", "taking over the lease neither requeues nor re-leases the retired job");
    await assertFinishedWithoutOlx(db, await finish(db, claimed.run.leaseToken!));
  } finally {
    await db.close();
  }
});

test("operator resume of the same run: resumed without waiting for OLX and finished without OLX", async () => {
  const db = await production();
  fetched.length = 0;
  try {
    await applyPr16(db);
    const resumed = await resumeExistingRadarRun(CHAIN_OWNER, RUN, postgrest(db) as never);
    assert.equal(resumed.kind, "claimed", "resume is not blocked by the legacy OLX stage");
    if (resumed.kind !== "claimed") return;
    await assertFinishedWithoutOlx(db, await finish(db, resumed.run.leaseToken!));
  } finally {
    await db.close();
  }
});

test("order merge -> Radar continuation -> migration: Radar re-leases the queued job first, the migration still retires it", async () => {
  const db = await production();
  fetched.length = 0;
  try {
    // New code, old database: the automatic continuation re-leases the queued job (old SQL) but never queues OLX.
    const claimed = await claimOrCreateRadarRun(CHAIN_OWNER, [], postgrest(db) as never);
    if (claimed.kind !== "claimed") throw new Error("expected the expired run to be taken over");
    assert.equal((await theJob(db)).status, "queued", "still pending until the migration (see the control test)");
    await applyPr16(db);
    assert.equal((await theJob(db)).error_code, "RADAR_OLX_REMOVED");
    const current = (await db.query<{ lease_token: string }>(`select lease_token from public.price_radar_runs where id = $1`, [RUN])).rows[0];
    await assertFinishedWithoutOlx(db, await finish(db, current.lease_token));
  } finally {
    await db.close();
  }
});
