/** Shared PGlite database for the OLX schedule tests (real queue + schedule migrations). */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const QUEUE = fs.readFileSync(path.join(MIGRATIONS, "20260810190000_create_olx_local_worker_queue.sql"), "utf8");
export const SCHEDULE = fs.readFileSync(path.join(MIGRATIONS, "20261014120000_add_finder_olx_schedule.sql"), "utf8");
export const ROLLBACK = fs.readFileSync(path.join(process.cwd(), "scripts/finder-olx-schedule.rollback.sql"), "utf8");

export const FLIP = "22222222-2222-4222-8222-222222222222";
export const OTHER = "33333333-3333-4333-8333-333333333333";
export const OLX_ONLY = "55555555-5555-4555-8555-555555555555";
export const OWNER = "00000000-0000-4000-8000-000000000001";
export const URL = "https://www.olx.pl/nieruchomosci/mieszkania/sprzedaz/lodz/";

export type Decision = Record<string, unknown> & { decision: string; reason: string | null };

export async function database(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    insert into auth.users (id) values ('${OWNER}');
    create table public.search_filters (
      id uuid primary key, is_active boolean not null default true, sources jsonb not null default '[]'::jsonb,
      finder_scan_interval_minutes integer not null default 300, last_scanned_at timestamptz
    );
    insert into public.search_filters (id, sources) values
      ('${FLIP}', '["otodom","gratka","olx"]'), ('${OTHER}', '["olx","morizon"]'), ('${OLX_ONLY}', '["olx"]');
    create table public.source_scans (
      id uuid primary key default gen_random_uuid(),
      search_filter_id uuid not null references public.search_filters(id),
      source text not null, status text not null default 'pending', scan_run_id uuid, filter_snapshot jsonb,
      started_at timestamptz not null default now(), finished_at timestamptz, error_message text,
      constraint source_scans_status_check check (status in ('pending','running','completed','failed','partial'))
    );
    create table public.price_radar_runs (id uuid primary key);
  `);
  await db.exec(QUEUE);
  await db.exec(`
    alter table public.olx_scan_jobs alter column source_scan_id drop not null, alter column search_filter_id drop not null;
    alter table public.olx_scan_jobs add column if not exists context_type text not null default 'finder';
    alter table public.olx_scan_jobs add column if not exists radar_owner_id uuid references auth.users(id);
    alter table public.olx_scan_jobs add column if not exists radar_run_id uuid references public.price_radar_runs(id);
    alter table public.olx_scan_jobs add column if not exists radar_lease_token uuid;
  `);
  await db.exec(SCHEDULE);
  return db;
}

/** Moves every stored OLX timestamp back, i.e. lets `minutes` pass on the database clock. */
export async function elapseMinutes(db: PGlite, minutes: number) {
  await db.exec(`
    update public.olx_scan_jobs set created_at = created_at - interval '${minutes} minutes',
      started_at = started_at - interval '${minutes} minutes', finished_at = finished_at - interval '${minutes} minutes';
    update public.source_scans set started_at = started_at - interval '${minutes} minutes';
  `);
}

/** Leaves only the given filters active (others would otherwise win the fairness rule). */
export async function onlyActive(db: PGlite, ...ids: string[]) {
  await db.query(`update public.search_filters set is_active = (id = any($1::uuid[]))`, [ids]);
}
