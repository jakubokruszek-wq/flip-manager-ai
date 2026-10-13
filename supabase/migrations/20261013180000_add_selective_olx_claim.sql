-- Selective, atomic claim of ONE named Finder OLX job, for the controlled
-- Cloudflare worker test (stage 2, manual mode, GitHub Actions).
--
-- NOT APPLIED automatically. Requires explicit approval before running it in
-- the Supabase SQL editor or with `supabase db push`.
-- Purely additive: one new function. No table, column, index, row or existing
-- function changes; claim_olx_scan_job and every running worker behave as before.
--
-- Why a separate function: claim_olx_scan_job always takes the OLDEST queued
-- job (Finder or Radar) and, as a side effect, re-queues or fails OTHER jobs
-- whose leases expired. A controlled test must touch nothing but the one job it
-- was pointed at. This function:
--   * selects only the queued Finder job with the given id (never Radar, never
--     another job, no filter or "oldest" selection);
--   * never updates any other olx_scan_jobs row (no lease recovery/exhaustion);
--   * locks with FOR UPDATE SKIP LOCKED, so it cannot race a regular worker:
--     a job is claimed by exactly one of them;
--   * sets the lease exactly like claim_olx_scan_job (same columns), so the
--     existing heartbeat / complete / fail endpoints work unchanged.

begin;

create or replace function public.claim_olx_scan_job_selective(
  p_worker_id text,
  p_job_id uuid,
  p_lease_seconds integer default 120
)
returns setof public.olx_scan_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.olx_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;

  if p_job_id is null then
    raise exception 'job_id is required';
  end if;

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where id = p_job_id
     and status = 'queued'
     and context_type = 'finder'
     and available_at <= now()
     and attempts < max_attempts
   for update skip locked;

  if claimed.id is null then
    return;
  end if;

  update public.olx_scan_jobs
     set status = 'running',
         attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(),
         worker_id = p_worker_id,
         started_at = coalesce(started_at, now()),
         error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id
     and status = 'pending';

  return next claimed;
end;
$$;

revoke all on function public.claim_olx_scan_job_selective(text, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_olx_scan_job_selective(text, uuid, integer) to service_role;

commit;
