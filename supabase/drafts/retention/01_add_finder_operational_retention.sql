-- SEPARATE RETENTION STAGE — not part of the Finder repair deployment.
-- Kept outside supabase/migrations so `supabase db push` or a Git integration
-- can never apply it by merging the Finder PR. Requires operator approval.
-- Applying this migration deletes NOTHING by itself. It only creates:
--   * aggregate tables that keep daily statistics of expired operational rows,
--   * public.finder_retention_report()   -- read-only dry-run report,
--   * public.finder_retention_run(...)   -- bounded batches, dry-run by default,
--   * public.finder_retention_runs       -- log of every run (counts + sizes).
-- A schedule is configured separately (03_configure_finder_retention_cron.sql).
--
-- Policy (operational data only):
--   gallery_request_traces       delete after 14 days (diagnostics)
--   *_nonces                     delete 1 hour after expiry (replay window long gone)
--   collector_scan_batches       payload compacted 14 days after a terminal finish,
--                                row deleted after 90 days (daily stats kept)
--   source_scans                 terminal scans older than 30 days: JSON diagnostics
--                                compacted; the row is deleted only when nothing
--                                references it and it is not the latest scan of its
--                                filter/source (daily stats kept)
-- Never touched: listings, listing_snapshots (price history), listing_filter_matches,
-- listing_filter_match_audit, listing_source_metadata, manual decisions, alerts,
-- resale_comps, Investment OS, Price Radar, properties/CRM.
begin;

create table if not exists public.finder_scan_daily_stats (
  day date not null,
  search_filter_id uuid not null,
  source text not null,
  scans integer not null default 0,
  completed integer not null default 0,
  partial integer not null default 0,
  failed integer not null default 0,
  scanned_count bigint not null default 0,
  matched_count bigint not null default 0,
  new_count bigint not null default 0,
  listings_created bigint not null default 0,
  listings_updated bigint not null default 0,
  price_drop_count bigint not null default 0,
  first_started_at timestamptz,
  last_finished_at timestamptz,
  primary key (day, search_filter_id, source)
);

create table if not exists public.finder_collector_batch_daily_stats (
  day date not null,
  source_type text not null,
  status text not null,
  batches integer not null default 0,
  visible_card_count bigint not null default 0,
  captured_post_count bigint not null default 0,
  primary key (day, source_type, status)
);

create table if not exists public.finder_retention_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  dry_run boolean not null,
  batch_size integer not null,
  max_batches integer not null,
  summary jsonb not null default '[]'::jsonb,
  table_bytes_before jsonb not null default '{}'::jsonb,
  table_bytes_after jsonb not null default '{}'::jsonb
);

alter table public.finder_scan_daily_stats enable row level security;
alter table public.finder_collector_batch_daily_stats enable row level security;
alter table public.finder_retention_runs enable row level security;
revoke all on table public.finder_scan_daily_stats from public, anon, authenticated;
revoke all on table public.finder_collector_batch_daily_stats from public, anon, authenticated;
revoke all on table public.finder_retention_runs from public, anon, authenticated;
grant select on table public.finder_scan_daily_stats to service_role;
grant select on table public.finder_collector_batch_daily_stats to service_role;
grant select on table public.finder_retention_runs to service_role;

create or replace function public.finder_retention_table_bytes()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_object_agg(name, pg_total_relation_size(to_regclass('public.' || name))), '{}'::jsonb)
  from unnest(array['gallery_request_traces', 'facebook_worker_nonces', 'olx_worker_nonces', 'collector_request_nonces', 'collector_scan_batches', 'source_scans', 'listing_snapshots', 'listings']) as name
  where to_regclass('public.' || name) is not null;
$$;

-- Candidate predicates live in one place each, shared by the report and the run.
create or replace function public.finder_retention_source_scan_deletable(s public.source_scans)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select s.status in ('completed', 'failed', 'partial')
    and s.finished_at is not null
    and s.finished_at < now() - interval '30 days'
    and coalesce(s.continuation_lease_until, '-infinity'::timestamptz) < now()
    -- provenance of a saved membership is kept
    and not exists (select 1 from public.listing_filter_matches m where m.source_scan_id = s.id)
    -- the latest scan of each filter/source stays as the "last scan" shown in Finder
    and exists (
      select 1 from public.source_scans newer
      where newer.search_filter_id = s.search_filter_id and newer.source = s.source and newer.started_at > s.started_at
    )
    -- a worker job that is not terminal protects its scan (ON DELETE CASCADE)
    and not exists (select 1 from public.olx_scan_jobs j where j.source_scan_id = s.id and j.status in ('queued', 'running'))
    and not exists (select 1 from public.facebook_scan_jobs j where j.source_scan_id = s.id and j.status in ('queued', 'running'));
$$;

create or replace function public.finder_retention_report()
returns table (table_name text, action text, eligible_rows bigint, protected_rows bigint, estimated_bytes bigint, total_rows bigint, total_bytes bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return query
  select 'gallery_request_traces'::text, 'delete'::text,
    count(*) filter (where t.created_at < now() - interval '14 days'),
    0::bigint,
    coalesce(sum(pg_column_size(t.*)) filter (where t.created_at < now() - interval '14 days'), 0)::bigint,
    count(*), pg_total_relation_size('public.gallery_request_traces')
  from public.gallery_request_traces t;

  return query
  select 'facebook_worker_nonces'::text, 'delete'::text,
    count(*) filter (where t.expires_at < now() - interval '1 hour'),
    count(*) filter (where t.expires_at >= now() - interval '1 hour'),
    coalesce(sum(pg_column_size(t.*)) filter (where t.expires_at < now() - interval '1 hour'), 0)::bigint,
    count(*), pg_total_relation_size('public.facebook_worker_nonces')
  from public.facebook_worker_nonces t;

  return query
  select 'olx_worker_nonces'::text, 'delete'::text,
    count(*) filter (where t.expires_at < now() - interval '1 hour'),
    count(*) filter (where t.expires_at >= now() - interval '1 hour'),
    coalesce(sum(pg_column_size(t.*)) filter (where t.expires_at < now() - interval '1 hour'), 0)::bigint,
    count(*), pg_total_relation_size('public.olx_worker_nonces')
  from public.olx_worker_nonces t;

  return query
  select 'collector_request_nonces'::text, 'delete'::text,
    count(*) filter (where t.expires_at < now() - interval '1 hour'),
    count(*) filter (where t.expires_at >= now() - interval '1 hour'),
    coalesce(sum(pg_column_size(t.*)) filter (where t.expires_at < now() - interval '1 hour'), 0)::bigint,
    count(*), pg_total_relation_size('public.collector_request_nonces')
  from public.collector_request_nonces t;

  return query
  select 'collector_scan_batches'::text, 'compact_payload'::text,
    count(*) filter (where t.status in ('completed', 'degraded', 'failed') and t.finished_at < now() - interval '14 days' and not (t.payload ? 'compacted_at')),
    count(*) filter (where t.status in ('received', 'processing') or t.finished_at is null),
    coalesce(sum(pg_column_size(t.payload)) filter (where t.status in ('completed', 'degraded', 'failed') and t.finished_at < now() - interval '14 days' and not (t.payload ? 'compacted_at')), 0)::bigint,
    count(*), pg_total_relation_size('public.collector_scan_batches')
  from public.collector_scan_batches t;

  return query
  select 'collector_scan_batches'::text, 'delete'::text,
    count(*) filter (where t.status in ('completed', 'degraded', 'failed') and t.finished_at < now() - interval '90 days'),
    0::bigint,
    coalesce(sum(pg_column_size(t.*)) filter (where t.status in ('completed', 'degraded', 'failed') and t.finished_at < now() - interval '90 days'), 0)::bigint,
    count(*), pg_total_relation_size('public.collector_scan_batches')
  from public.collector_scan_batches t;

  return query
  select 'source_scans'::text, 'compact_json'::text,
    count(*) filter (where s.status in ('completed', 'failed', 'partial') and s.finished_at < now() - interval '30 days' and not (s.filter_snapshot ? 'compacted_at')),
    count(*) filter (where s.status in ('pending', 'running')),
    coalesce(sum(pg_column_size(s.filter_snapshot) + pg_column_size(s.diagnostics)) filter (where s.status in ('completed', 'failed', 'partial') and s.finished_at < now() - interval '30 days' and not (s.filter_snapshot ? 'compacted_at')), 0)::bigint,
    count(*), pg_total_relation_size('public.source_scans')
  from public.source_scans s;

  return query
  select 'source_scans'::text, 'delete'::text,
    count(*) filter (where public.finder_retention_source_scan_deletable(s)),
    count(*) filter (where s.status in ('completed', 'failed', 'partial') and s.finished_at < now() - interval '30 days' and not public.finder_retention_source_scan_deletable(s)),
    coalesce(sum(pg_column_size(s.*)) filter (where public.finder_retention_source_scan_deletable(s)), 0)::bigint,
    count(*), pg_total_relation_size('public.source_scans')
  from public.source_scans s;

  -- Investment data is reported for transparency and never eligible.
  return query
  select 'listing_snapshots'::text, 'keep'::text, 0::bigint, count(*), 0::bigint, count(*), pg_total_relation_size('public.listing_snapshots')
  from public.listing_snapshots;
end;
$$;

create or replace function public.finder_retention_run(
  p_dry_run boolean default true,
  p_batch_size integer default 500,
  p_max_batches integer default 10
)
returns table (table_name text, action text, affected_rows bigint, dry_run boolean)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  batch_size integer := least(greatest(coalesce(p_batch_size, 500), 1), 5000);
  max_batches integer := least(greatest(coalesce(p_max_batches, 10), 1), 100);
  run_id uuid;
  affected bigint;
  total bigint;
  i integer;
  results jsonb := '[]'::jsonb;
begin
  -- Never wait on a row/table lock held by a live scan or worker.
  set local lock_timeout = '2s';
  set local statement_timeout = '120s';

  insert into public.finder_retention_runs (dry_run, batch_size, max_batches, table_bytes_before)
  values (coalesce(p_dry_run, true), batch_size, max_batches, public.finder_retention_table_bytes())
  returning id into run_id;

  if coalesce(p_dry_run, true) then
    for table_name, action, affected_rows in
      select r.table_name, r.action, least(r.eligible_rows, batch_size::bigint * max_batches) from public.finder_retention_report() r where r.action <> 'keep'
    loop
      dry_run := true;
      results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', affected_rows);
      return next;
    end loop;
    update public.finder_retention_runs set finished_at = now(), summary = results, table_bytes_after = table_bytes_before where id = run_id;
    return;
  end if;

  -- gallery_request_traces
  total := 0;
  for i in 1..max_batches loop
    delete from public.gallery_request_traces t
    where t.ctid = any(array(
      select x.ctid from public.gallery_request_traces x
      where x.created_at < now() - interval '14 days'
      order by x.created_at limit batch_size for update skip locked));
    get diagnostics affected = row_count;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'gallery_request_traces'; action := 'delete'; affected_rows := total; dry_run := false;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  -- expired nonces (one hour past expiry: replay checks use the expiry itself)
  total := 0;
  for i in 1..max_batches loop
    delete from public.facebook_worker_nonces t
    where t.ctid = any(array(select x.ctid from public.facebook_worker_nonces x where x.expires_at < now() - interval '1 hour' limit batch_size for update skip locked));
    get diagnostics affected = row_count;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'facebook_worker_nonces'; action := 'delete'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  total := 0;
  for i in 1..max_batches loop
    delete from public.olx_worker_nonces t
    where t.ctid = any(array(select x.ctid from public.olx_worker_nonces x where x.expires_at < now() - interval '1 hour' limit batch_size for update skip locked));
    get diagnostics affected = row_count;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'olx_worker_nonces'; action := 'delete'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  total := 0;
  for i in 1..max_batches loop
    delete from public.collector_request_nonces t
    where t.ctid = any(array(select x.ctid from public.collector_request_nonces x where x.expires_at < now() - interval '1 hour' limit batch_size for update skip locked));
    get diagnostics affected = row_count;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'collector_request_nonces'; action := 'delete'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  -- collector batches: compact the large payload of finished batches after 14 days
  total := 0;
  for i in 1..max_batches loop
    update public.collector_scan_batches t
       set payload = jsonb_build_object('compacted_at', now(), 'retention', 'finder-v1', 'captured_post_count', t.captured_post_count)
     where t.ctid = any(array(
       select x.ctid from public.collector_scan_batches x
       where x.status in ('completed', 'degraded', 'failed') and x.finished_at < now() - interval '14 days' and not (x.payload ? 'compacted_at')
       order by x.finished_at limit batch_size for update skip locked));
    get diagnostics affected = row_count;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'collector_scan_batches'; action := 'compact_payload'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  -- collector batches older than 90 days: keep daily totals, delete the row
  total := 0;
  for i in 1..max_batches loop
    with victims as (
      select x.ctid as row_ctid from public.collector_scan_batches x
      where x.status in ('completed', 'degraded', 'failed') and x.finished_at < now() - interval '90 days'
      order by x.finished_at limit batch_size for update skip locked
    ), deleted as (
      delete from public.collector_scan_batches t using victims where t.ctid = victims.row_ctid
      returning t.received_at, t.source_type, t.status, t.visible_card_count, t.captured_post_count
    ), aggregated as (
      insert into public.finder_collector_batch_daily_stats as d (day, source_type, status, batches, visible_card_count, captured_post_count)
      select (received_at at time zone 'Europe/Warsaw')::date, source_type, status, count(*), sum(visible_card_count), sum(captured_post_count)
      from deleted group by 1, 2, 3
      on conflict (day, source_type, status) do update set
        batches = d.batches + excluded.batches,
        visible_card_count = d.visible_card_count + excluded.visible_card_count,
        captured_post_count = d.captured_post_count + excluded.captured_post_count
      returning 1
    )
    select count(*) into affected from deleted;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'collector_scan_batches'; action := 'delete'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  -- source scans: compact JSON diagnostics of terminal scans older than 30 days
  total := 0;
  for i in 1..max_batches loop
    update public.source_scans s
       set filter_snapshot = jsonb_build_object('compacted_at', now(), 'retention', 'finder-v1'),
           diagnostics = '[]'::jsonb
     where s.ctid = any(array(
       select x.ctid from public.source_scans x
       where x.status in ('completed', 'failed', 'partial') and x.finished_at < now() - interval '30 days' and not (x.filter_snapshot ? 'compacted_at')
         and coalesce(x.continuation_lease_until, '-infinity'::timestamptz) < now()
       order by x.finished_at limit batch_size for update skip locked));
    get diagnostics affected = row_count;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'source_scans'; action := 'compact_json'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  -- source scans: delete unreferenced, non-latest terminal scans; keep daily totals
  total := 0;
  for i in 1..max_batches loop
    with victims as (
      select x.ctid as row_ctid from public.source_scans x
      where public.finder_retention_source_scan_deletable(x)
      order by x.finished_at limit batch_size for update skip locked
    ), deleted as (
      delete from public.source_scans t using victims where t.ctid = victims.row_ctid
      returning t.started_at, t.finished_at, t.search_filter_id, t.source, t.status, t.scanned_count, t.matched_count, t.new_count, t.listings_created, t.listings_updated, t.price_drop_count
    ), aggregated as (
      insert into public.finder_scan_daily_stats as d (day, search_filter_id, source, scans, completed, partial, failed, scanned_count, matched_count, new_count, listings_created, listings_updated, price_drop_count, first_started_at, last_finished_at)
      select (started_at at time zone 'Europe/Warsaw')::date, search_filter_id, source, count(*),
        count(*) filter (where status = 'completed'), count(*) filter (where status = 'partial'), count(*) filter (where status = 'failed'),
        sum(scanned_count), sum(matched_count), sum(new_count), sum(listings_created), sum(listings_updated), sum(price_drop_count),
        min(started_at), max(finished_at)
      from deleted group by 1, 2, 3
      on conflict (day, search_filter_id, source) do update set
        scans = d.scans + excluded.scans,
        completed = d.completed + excluded.completed,
        partial = d.partial + excluded.partial,
        failed = d.failed + excluded.failed,
        scanned_count = d.scanned_count + excluded.scanned_count,
        matched_count = d.matched_count + excluded.matched_count,
        new_count = d.new_count + excluded.new_count,
        listings_created = d.listings_created + excluded.listings_created,
        listings_updated = d.listings_updated + excluded.listings_updated,
        price_drop_count = d.price_drop_count + excluded.price_drop_count,
        first_started_at = least(d.first_started_at, excluded.first_started_at),
        last_finished_at = greatest(d.last_finished_at, excluded.last_finished_at)
      returning 1
    )
    select count(*) into affected from deleted;
    total := total + affected;
    exit when affected < batch_size;
  end loop;
  table_name := 'source_scans'; action := 'delete'; affected_rows := total;
  results := results || jsonb_build_object('table', table_name, 'action', action, 'rows', total); return next;

  -- Deleted space becomes reusable after (auto)vacuum; the files shrink only
  -- with VACUUM FULL, which is never run automatically (operator approval).
  update public.finder_retention_runs
     set finished_at = now(), summary = results, table_bytes_after = public.finder_retention_table_bytes()
   where id = run_id;
end;
$$;

revoke all on function public.finder_retention_table_bytes() from public, anon, authenticated;
revoke all on function public.finder_retention_source_scan_deletable(public.source_scans) from public, anon, authenticated;
revoke all on function public.finder_retention_report() from public, anon, authenticated;
revoke all on function public.finder_retention_run(boolean, integer, integer) from public, anon, authenticated;
grant execute on function public.finder_retention_report() to service_role;
grant execute on function public.finder_retention_run(boolean, integer, integer) to service_role;

commit;
