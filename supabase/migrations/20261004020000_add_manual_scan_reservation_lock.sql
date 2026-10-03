begin;

-- DRAFT -- not applied by this change (see the application-side caller in
-- features/flip-finder/server/manual-scan.ts's reserveSourceScans, and the
-- barrier-forced proof in manual-scan-lock-separation.test.ts). Prepared so a
-- human can review and apply it to close Issue 1 from the scan-lifecycle
-- review: startManualOtodomScan's reservation is a plain SELECT-then-INSERT
-- with no database-level mutual exclusion, so two concurrent requests for the
-- same filter can both pass the "already running" check before either
-- commits, producing two active source_scans rows for the same
-- search_filter_id+source pair. Confirmed via the schema: source_scans has
-- no unique constraint beyond its primary key (20260719113000), and the only
-- existing atomic "claim" pattern (claim_olx_scan_job, 20260810190000)
-- required its own dedicated migration -- there is no zero-migration way to
-- get a cross-instance guarantee here (no generic SQL-execution RPC exists
-- to reach pg_advisory_lock, and a JS-level mutex only protects one process).
--
-- Mirrors enqueue_facebook_gallery_job's proven pattern (20260907090000):
-- lock the parent row with SELECT ... FOR UPDATE so a second concurrent call
-- blocks until the first transaction commits, then re-reads the now-committed
-- state and correctly observes the winner's rows -- no new table, column, or
-- index required, just this one function.
create or replace function public.reserve_source_scans(
  p_search_filter_id uuid,
  p_sources text[],
  p_scan_run_id uuid,
  p_filter_snapshot jsonb
)
returns setof public.source_scans
language plpgsql
security definer
set search_path = public
as $$
declare
  locked_filter_id uuid;
  existing_count integer;
begin
  if p_search_filter_id is null then
    raise exception 'search_filter_id is required';
  end if;
  if p_sources is null or array_length(p_sources, 1) is null then
    raise exception 'sources is required';
  end if;
  if p_scan_run_id is null then
    raise exception 'scan_run_id is required';
  end if;

  -- Serializes every concurrent reservation attempt for this filter: the
  -- second caller blocks here until the first caller's transaction commits
  -- or rolls back, then proceeds with a fresh read below.
  select id into locked_filter_id
    from public.search_filters
   where id = p_search_filter_id
   for update;

  if locked_filter_id is null then
    raise exception 'SEARCH_FILTER_NOT_FOUND';
  end if;

  select count(*) into existing_count
    from public.source_scans
   where search_filter_id = p_search_filter_id
     and source = any(p_sources)
     and status in ('pending', 'running');

  if existing_count > 0 then
    raise exception 'SCAN_ALREADY_RUNNING';
  end if;

  return query
    insert into public.source_scans (search_filter_id, source, status, scan_run_id, filter_snapshot)
    select p_search_filter_id, src, 'pending', p_scan_run_id, p_filter_snapshot
      from unnest(p_sources) as src
    returning *;
end;
$$;

revoke all on function public.reserve_source_scans(uuid, text[], uuid, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_source_scans(uuid, text[], uuid, jsonb) to service_role;

commit;
