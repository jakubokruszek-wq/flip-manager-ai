begin;

-- Lease recovery is consumer-scoped. A legacy worker must never requeue an
-- active browser-extension job (and vice versa).
create or replace function public.claim_facebook_scan_job(
  p_worker_id text,
  p_lease_seconds integer default 180,
  p_consumer_type text default 'LEGACY_WORKER'
)
returns setof public.facebook_scan_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.facebook_scan_jobs%rowtype;
begin
  if length(trim(coalesce(p_worker_id, ''))) < 3 then
    raise exception 'worker_id is required';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'lease_seconds must be between 30 and 300';
  end if;
  if p_consumer_type not in ('BROWSER_EXTENSION', 'LEGACY_WORKER') then
    raise exception 'consumer_type is invalid';
  end if;

  with exhausted as (
    update public.facebook_scan_jobs
       set status = 'failed', finished_at = now(), leased_until = null,
           lease_token = null, error_code = 'LEASE_EXHAUSTED',
           error_message = 'Facebook worker lease expired after maximum attempts'
     where status = 'running'
       and consumer_type = p_consumer_type
       and leased_until < now()
       and attempts >= max_attempts
     returning source_scan_id
  )
  update public.source_scans scans
     set status = 'failed', finished_at = now(),
         error_message = 'Facebook worker lease expired after maximum attempts'
   where scans.id in (select source_scan_id from exhausted)
     and scans.status in ('pending', 'running');

  update public.facebook_scan_jobs
     set status = 'queued', available_at = now(), leased_until = null,
         lease_token = null, worker_id = null, error_code = 'LEASE_RECOVERED',
         error_message = 'Previous Facebook worker lease expired'
   where status = 'running'
     and consumer_type = p_consumer_type
     and leased_until < now()
     and attempts < max_attempts;

  select * into claimed
    from public.facebook_scan_jobs
   where status = 'queued'
     and consumer_type = p_consumer_type
     and available_at <= now()
     and attempts < max_attempts
   order by created_at asc
   for update skip locked
   limit 1;

  if claimed.id is null then
    return;
  end if;

  update public.facebook_scan_jobs
     set status = 'running', attempts = attempts + 1,
         lease_token = gen_random_uuid(),
         leased_until = now() + make_interval(secs => p_lease_seconds),
         heartbeat_at = now(), worker_id = p_worker_id,
         started_at = coalesce(started_at, now()), error_code = null,
         error_message = null
   where id = claimed.id
   returning * into claimed;

  update public.source_scans
     set status = 'running', error_message = null
   where id = claimed.source_scan_id and status = 'pending';

  return next claimed;
end;
$$;

revoke all on function public.claim_facebook_scan_job(text, integer, text) from public, anon, authenticated;
grant execute on function public.claim_facebook_scan_job(text, integer, text) to service_role;

-- Atomic browser-extension renewal. The exact device, lease token, consumer,
-- and running status are all checked by the UPDATE predicate.
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
  update public.facebook_scan_jobs
     set heartbeat_at = now(),
         leased_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_job_id
     and consumer_type = 'BROWSER_EXTENSION'
     and status = 'running'
     and lease_token = p_lease_token
     and worker_id = p_worker_id
     and leased_until >= now()
   returning id, leased_until;
end;
$$;

revoke all on function public.renew_facebook_scan_job(uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.renew_facebook_scan_job(uuid, text, uuid, integer) to service_role;

commit;
