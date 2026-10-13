-- Selective, atomic claim of ONE Finder OLX job, for the limited Cloudflare
-- worker trial (workers/olx-cloudflare, manual mode).
--
-- NOT APPLIED. Requires explicit approval before `supabase db push` / SQL editor.
-- Purely additive: one new function, no table, column, row or existing
-- function is changed. The existing claim_olx_scan_job and every running
-- worker behave exactly as before.
--
-- Why a separate function: claim_olx_scan_job always takes the OLDEST queued
-- job and, as a side effect, recovers or exhausts OTHER jobs' expired leases.
-- A trial must not touch any job but the one it was pointed at. This function:
--   * selects only a queued Finder job with the given id or search filter;
--   * never updates any other olx_scan_jobs row (no lease recovery/exhaustion);
--   * locks with FOR UPDATE SKIP LOCKED, so it cannot race a regular worker:
--     a job is claimed by exactly one of them;
--   * sets the lease exactly like claim_olx_scan_job (same columns), so
--     heartbeat / complete / fail work unchanged.

begin;

create or replace function public.claim_olx_scan_job_selective(
  p_worker_id text,
  p_job_id uuid default null,
  p_search_filter_id uuid default null,
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

  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  if (p_job_id is null) = (p_search_filter_id is null) then
    raise exception 'exactly one of job_id or search_filter_id is required';
  end if;

  select * into claimed
    from public.olx_scan_jobs
   where status = 'queued'
     and available_at <= now()
     and context_type = 'finder'
     and (p_job_id is null or id = p_job_id)
     and (p_search_filter_id is null or search_filter_id = p_search_filter_id)
   order by created_at asc
   for update skip locked
   limit 1;

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

revoke all on function public.claim_olx_scan_job_selective(text, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_olx_scan_job_selective(text, uuid, uuid, integer) to service_role;

commit;
