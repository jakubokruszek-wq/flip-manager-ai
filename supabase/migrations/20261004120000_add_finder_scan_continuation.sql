begin;

-- DRAFT -- not applied by this change. Finder source rows need durable state
-- because a serverless invocation may end after a source has been reserved but
-- before the remaining sources run. OLX and Facebook are deliberately excluded
-- from the claim function: each has its own worker queue and lease protocol.
alter table public.source_scans
  add column if not exists continuation_attempt integer not null default 0,
  add column if not exists continuation_next_at timestamptz,
  add column if not exists continuation_cycle_at timestamptz,
  add column if not exists continuation_lease_token uuid,
  add column if not exists continuation_lease_until timestamptz;

alter table public.source_scans
  drop constraint if exists source_scans_continuation_attempt_check;

alter table public.source_scans
  add constraint source_scans_continuation_attempt_check
  check (continuation_attempt >= 0);

create index if not exists source_scans_continuation_due_idx
  on public.source_scans (continuation_next_at, continuation_cycle_at, started_at)
  where status in ('pending', 'running') and source not in ('olx', 'facebook');

create or replace function public.claim_finder_scan_source(
  p_cycle_at timestamptz,
  p_now timestamptz default now(),
  p_lease_seconds integer default 240
)
returns setof public.source_scans
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  if p_cycle_at is null or p_now is null then
    raise exception 'continuation timestamps are required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'invalid continuation lease';
  end if;

  -- One row is selected and locked atomically. A second cron invocation either
  -- sees the row's new cycle/token or skips it, so a source runs at most once
  -- per hourly cycle. A row that was switched to running by an invocation
  -- which was killed before it could attach a lease is reclaimable after the
  -- five-minute orphan grace period; a live first invocation is left alone.
  select id into claimed_id
    from public.source_scans
   where source not in ('olx', 'facebook')
     and (continuation_next_at is null or continuation_next_at <= p_now)
     and (continuation_cycle_at is null or continuation_cycle_at < p_cycle_at)
     and (
       status = 'pending'
       or (
         status = 'running'
         and (
           (continuation_lease_until is not null and continuation_lease_until <= p_now)
           or (
             continuation_lease_until is null
             and started_at <= p_now - interval '5 minutes'
           )
         )
       )
     )
   order by coalesce(continuation_next_at, started_at), started_at
   for update skip locked
   limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
    update public.source_scans
       set status = 'running',
           continuation_attempt = continuation_attempt + 1,
           continuation_cycle_at = p_cycle_at,
           continuation_lease_token = gen_random_uuid(),
           continuation_lease_until = p_now + make_interval(secs => p_lease_seconds)
     where id = claimed_id
     returning *;
end;
$$;

revoke all on function public.claim_finder_scan_source(timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_finder_scan_source(timestamptz, timestamptz, integer) to service_role;

commit;
