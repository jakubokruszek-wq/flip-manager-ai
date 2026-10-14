/**
 * The real OLX queue, Price Radar and Finder OLX schedule migrations, in
 * order, on top of minimal search_filters / source_scans tables. Shared by the
 * PGlite tests and the real-PostgreSQL concurrency test, so both run exactly
 * the SQL that would be applied in Production.
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");

export const CHAIN_FLIP = "22222222-2222-4222-8222-222222222222";
export const CHAIN_OTHER = "33333333-3333-4333-8333-333333333333";
export const CHAIN_OWNER = "00000000-0000-4000-8000-000000000001";
export const CHAIN_URL = "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/";

export const CHAIN_BASE_SQL = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
  end $$;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $f$ select null::uuid $f$;
  insert into auth.users (id) values ('${CHAIN_OWNER}');
  create table public.search_filters (
    id uuid primary key, name text not null default 'Filtr', is_active boolean not null default true, sources jsonb not null default '[]'::jsonb,
    finder_scan_interval_minutes integer not null default 300, last_scanned_at timestamptz
  );
  insert into public.search_filters (id, sources) values ('${CHAIN_FLIP}', '["otodom","olx"]'), ('${CHAIN_OTHER}', '["olx","morizon"]');
  create table public.source_scans (
    id uuid primary key default gen_random_uuid(),
    search_filter_id uuid not null references public.search_filters(id),
    source text not null, status text not null default 'pending', scan_run_id uuid, filter_snapshot jsonb,
    started_at timestamptz not null default now(), finished_at timestamptz, error_message text,
    constraint source_scans_status_check check (status in ('pending','running','completed','failed','partial'))
  );
`;

/** Already in Production before PR #16, in the order they were applied. */
export const PRODUCTION_MIGRATIONS = [
  "20260810190000_create_olx_local_worker_queue.sql",
  "20261008000000_create_price_radar.sql",
  "20261011154631_add_radar_district_queue.sql",
  "20261011183209_add_terminal_price_radar_run_end.sql",
  "20261012110000_add_price_radar_stop_resume.sql",
  "20261012120000_fix_price_radar_stop_without_current_source.sql",
  "20261012130000_add_price_radar_verification_queue.sql",
  "20261013180000_add_selective_olx_claim.sql",
  "20261014120000_add_finder_olx_schedule.sql",
] as const;

/** PR #16, in the order they must be applied. */
export const PR16_MIGRATIONS = [
  "20261015120000_add_scheduled_olx_claim.sql",
  "20261016120000_olx_slot_schedule_and_radar_olx_removal.sql",
  "20261017120000_coordinate_olx_claims.sql",
] as const;

export const migration = (file: string) => fs.readFileSync(path.join(MIGRATIONS, file), "utf8");
export const script = (file: string) => fs.readFileSync(path.join(process.cwd(), "scripts", file), "utf8");

/** Base tables plus the given migrations, as one SQL text. */
export function chainSql(files: readonly string[]): string {
  return [CHAIN_BASE_SQL, ...files.map(migration)].join("\n;\n");
}

/** PGlite with Production's migrations, then `pr16` (default: all of PR #16). */
export async function chainDatabase(pr16: readonly string[] = PR16_MIGRATIONS): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(CHAIN_BASE_SQL);
  for (const file of [...PRODUCTION_MIGRATIONS, ...pr16]) await db.exec(migration(file));
  return db;
}

export type JobSeed = { key: string; filter?: string; requestedBy?: "scheduler" | "manual" | null; status?: string; ageMinutes?: number; attempts?: number; leasedForSeconds?: number | null; workerId?: string | null };

/** SQL inserting one Finder OLX job (and its source_scans row); returns nothing. */
export function jobSql(seed: JobSeed): string {
  const filter = seed.filter ?? CHAIN_FLIP;
  const status = seed.status ?? "queued";
  const scanStatus = status === "queued" ? "pending" : status === "running" ? "running" : status;
  const lease = seed.leasedForSeconds === undefined || seed.leasedForSeconds === null ? "null" : `now() + make_interval(secs => ${seed.leasedForSeconds})`;
  const requested = seed.requestedBy ? `'${seed.requestedBy}'` : "null";
  const worker = seed.workerId ? `'${seed.workerId}'` : "null";
  const created = `now() - make_interval(mins => ${seed.ageMinutes ?? 0})`;
  return `with scan as (
      insert into public.source_scans (search_filter_id, source, status) values ('${filter}', 'olx', '${scanStatus}') returning id
    )
    insert into public.olx_scan_jobs (scan_run_id, source_scan_id, search_filter_id, request_url, idempotency_key, requested_by, status,
      attempts, lease_token, leased_until, heartbeat_at, worker_id, started_at, created_at)
    select gen_random_uuid(), scan.id, '${filter}', '${CHAIN_URL}', '${seed.key}', ${requested}, '${status}',
      ${seed.attempts ?? (status === "queued" ? 0 : 1)}, ${status === "running" ? "gen_random_uuid()" : "null"}, ${lease},
      ${status === "running" ? "now()" : "null"}, ${worker}, ${status === "queued" ? "null" : created}, ${created}
      from scan;`;
}

export const USAGE_OK = JSON.stringify({ accountBrowserMs: 0, workerBrowserMs: 0, safeBudgetMs: 120_000, jobEstimateMs: 30_000 });
export const ENABLE_AUTOMATION = `update public.olx_automation_control set scheduled_claim_enabled = true, max_claims_24h = 2;`;
