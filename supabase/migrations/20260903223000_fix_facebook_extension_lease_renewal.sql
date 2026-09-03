begin;

-- `leased_until` is also an output parameter of this RETURNS TABLE function.
-- Qualify every job column so PL/pgSQL cannot resolve it as that parameter.
create or replace function public.renew_facebook_scan_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_lease_seconds integer default 180
)
returns table(job_id uuid, leased_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;

  return query
  update public.facebook_scan_jobs as jobs
     set heartbeat_at = now(),
         leased_until = now() + make_interval(secs => p_lease_seconds)
   where jobs.id = p_job_id
     and jobs.consumer_type = 'BROWSER_EXTENSION'
     and jobs.status = 'running'
     and jobs.lease_token = p_lease_token
     and jobs.worker_id = p_worker_id
     and jobs.leased_until >= now()
   returning jobs.id, jobs.leased_until;
end;
$$;

revoke all on function public.renew_facebook_scan_job(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_facebook_scan_job(uuid, text, uuid, integer) to service_role;

commit;
