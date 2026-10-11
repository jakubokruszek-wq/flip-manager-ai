begin;

-- LOCAL DRAFT ONLY. Do not apply or deploy code that depends on this draft
-- until its application has been separately verified in Production.
-- The existing partial status is reused for a resumable operator stop; no
-- source rows, listing rows, or OLX queue history are deleted.
alter table public.price_radar_runs
  add column if not exists stop_requested_at timestamptz;

create or replace function public.claim_price_radar_run(
  p_owner_id uuid,
  p_initial_checkpoint jsonb,
  p_lease_seconds integer default 120
)
returns table (run_id uuid, lease_token uuid, status text, checkpoint jsonb, source_statuses jsonb, scanned_count integer, qualified_count integer, started_at timestamptz, error_message text)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_run public.price_radar_runs%rowtype;
  new_token uuid := gen_random_uuid();
begin
  if p_owner_id is null or jsonb_typeof(p_initial_checkpoint) <> 'object' then
    raise exception 'invalid Radar run claim';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 180 then
    raise exception 'lease_seconds must be between 30 and 180';
  end if;

  select * into current_run from public.price_radar_runs r
   where r.owner_id = p_owner_id and r.status in ('pending', 'running')
   order by r.started_at desc limit 1 for update;
  if found then
    -- A stop is an explicit operator decision. An expired lease must not
    -- silently turn it into an automatic continuation or a competing run.
    if current_run.stop_requested_at is not null then
      return;
    end if;
    if current_run.lease_until is not null and current_run.lease_until > now() then
      return;
    end if;
    update public.price_radar_runs r set status = 'running', lease_token = new_token,
      lease_until = now() + make_interval(secs => p_lease_seconds), error_message = null
     where r.id = current_run.id
     returning r.id, r.lease_token, r.status, r.checkpoint, r.source_statuses, r.scanned_count, r.qualified_count, r.started_at, r.error_message
       into run_id, lease_token, status, checkpoint, source_statuses, scanned_count, qualified_count, started_at, error_message;
    update public.olx_scan_jobs j set radar_lease_token = new_token
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = current_run.id
       and j.status = 'queued';
    update public.olx_scan_jobs j set status = 'queued', available_at = now(), lease_token = null, leased_until = null,
      worker_id = null, heartbeat_at = now(), radar_lease_token = new_token,
      error_code = 'RADAR_LEASE_RECLAIMED', error_message = 'Prior Radar owner lease expired; worker job was requeued'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = current_run.id
       and j.status = 'running';
    return next;
    return;
  end if;

  insert into public.price_radar_runs as r (owner_id, status, checkpoint, lease_token, lease_until)
  values (p_owner_id, 'running', p_initial_checkpoint, new_token, now() + make_interval(secs => p_lease_seconds))
  returning r.id, r.lease_token, r.status, r.checkpoint, r.source_statuses, r.scanned_count, r.qualified_count, r.started_at, r.error_message
    into run_id, lease_token, status, checkpoint, source_statuses, scanned_count, qualified_count, started_at, error_message;
  return next;
exception when unique_violation then
  return;
end;
$$;

create or replace function public.request_price_radar_run_stop(
  p_owner_id uuid,
  p_run_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_run public.price_radar_runs%rowtype;
  source_queue jsonb;
  source_statuses jsonb;
  source_id text;
  source_index integer;
  queued_job_id uuid;
  stop_now boolean := false;
begin
  if p_owner_id is null or p_run_id is null then raise exception 'owner and run are required'; end if;
  select * into current_run from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id for update;
  if not found then return 'run_changed'; end if;
  if current_run.status = 'partial' and current_run.error_message = 'RADAR_STOPPED_BY_OPERATOR'
     and current_run.stop_requested_at is not null then return 'stopped'; end if;
  if current_run.status not in ('pending', 'running') then return 'not_active'; end if;

  source_queue := current_run.checkpoint->'sourceQueue';
  source_statuses := coalesce(current_run.checkpoint->'sourceStatuses', '{}'::jsonb);
  source_index := case when jsonb_typeof(current_run.checkpoint->'currentSourceIndex') = 'number'
    then (current_run.checkpoint->>'currentSourceIndex')::integer else -1 end;
  source_id := case when source_index >= 0 and jsonb_typeof(source_queue) = 'array'
    then source_queue->>source_index else null end;
  if source_id is not null and coalesce(source_statuses->>source_id, '') not in ('pending', 'running') then
    return 'not_active';
  end if;

  if current_run.stop_requested_at is null then
    -- Keep a live source marked running until its worker acknowledges STOP.
    -- That keeps the displayed per-source state truthful while the run is
    -- still in the stopping phase.
    update public.price_radar_runs r set stop_requested_at = now()
     where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('pending', 'running');
    if not found then return 'run_changed'; end if;
    current_run.stop_requested_at := now();
  end if;

  -- A queued OLX job has no worker to acknowledge the request. Fail only that
  -- run's reservation and finalize the same run as resumable partial now.
  if source_id = 'olx' then
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR',
      error_message = 'Operator stopped this Radar run before the OLX job was claimed'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
       and j.status = 'queued'
     returning j.id into queued_job_id;
    if queued_job_id is not null then stop_now := true; end if;
  end if;

  -- With no live Radar lease, the old owner can no longer write. Releasing it
  -- here prevents an expired run from blocking future operator actions.
  if current_run.lease_until is null or current_run.lease_until <= now() then stop_now := true; end if;

  if stop_now then
    if source_id is not null then
      source_statuses := jsonb_set(source_statuses, array[source_id], '"pending"'::jsonb, true);
      current_run.checkpoint := jsonb_set(current_run.checkpoint, '{sourceStatuses}', source_statuses, true);
      current_run.source_statuses := jsonb_set(coalesce(current_run.source_statuses, '{}'::jsonb), array[source_id], '"pending"'::jsonb, true);
    end if;
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR',
      error_message = 'Operator stopped this Radar run'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
       and j.status = 'running';
    update public.price_radar_runs r set status = 'partial', error_message = 'RADAR_STOPPED_BY_OPERATOR',
      checkpoint = current_run.checkpoint, source_statuses = current_run.source_statuses,
      finished_at = now(), lease_token = null, lease_until = null
     where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('pending', 'running')
       and r.stop_requested_at is not null;
    if not found then return 'run_changed'; end if;
    return 'stopped';
  end if;
  return 'stopping';
end;
$$;

-- Listing persistence takes the same run-row lock as STOP. A transaction that
-- acquired the lock first may commit before STOP; after STOP commits, stale or
-- in-flight workers cannot write any more Radar observations.
create or replace function public.persist_price_radar_listing(
  p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_listing jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
  saved_id uuid;
  inherited_excluded_at timestamptz;
  inherited_excluded_reason text;
begin
  perform 1 from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_lease_token and r.lease_until > now()
     and r.stop_requested_at is null
   for update;
  if not found then raise exception 'RADAR_LEASE_LOST'; end if;

  select l.id into existing_id from public.price_radar_listings l
   where l.owner_id = p_owner_id and l.source = p_listing->>'source'
     and (l.external_listing_id = p_listing->>'external_listing_id' or l.normalized_url = p_listing->>'normalized_url')
   order by (l.external_listing_id = p_listing->>'external_listing_id') desc, l.last_seen_at desc
   limit 1 for update;

  if nullif(p_listing->>'cross_source_identity', '') is not null then
    select l.excluded_at, l.excluded_reason into inherited_excluded_at, inherited_excluded_reason
      from public.price_radar_listings l
     where l.owner_id = p_owner_id and l.cross_source_identity = p_listing->>'cross_source_identity' and l.excluded_at is not null
     order by l.excluded_at desc limit 1 for update;
  end if;

  if existing_id is not null then
    update public.price_radar_listings l set
      external_listing_id = p_listing->>'external_listing_id', original_url = p_listing->>'original_url', normalized_url = p_listing->>'normalized_url',
      title = p_listing->>'title', description = p_listing->>'description', price = (p_listing->>'price')::numeric,
      area = (p_listing->>'area')::numeric, price_per_sqm = (p_listing->>'price_per_sqm')::numeric,
      rooms = nullif(p_listing->>'rooms', '')::integer, city = p_listing->>'city', district = p_listing->>'district',
      building_type = p_listing->>'building_type', market_type = p_listing->>'market_type', renovation_status = p_listing->>'renovation_status',
      content_hash = p_listing->>'content_hash', cross_source_identity = nullif(p_listing->>'cross_source_identity', ''),
      published_at = nullif(p_listing->>'published_at', '')::timestamptz, source_updated_at = nullif(p_listing->>'source_updated_at', '')::timestamptz,
      collected_at = (p_listing->>'collected_at')::timestamptz, last_seen_at = (p_listing->>'last_seen_at')::timestamptz,
      excluded_at = coalesce(l.excluded_at, inherited_excluded_at), excluded_reason = coalesce(l.excluded_reason, inherited_excluded_reason),
      status = 'active', raw_payload = coalesce(p_listing->'raw_payload', '{}'::jsonb)
    where l.id = existing_id returning l.id into saved_id;
  else
    insert into public.price_radar_listings (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description, price, area, price_per_sqm, rooms,
      city, district, building_type, market_type, renovation_status, content_hash, cross_source_identity, published_at, source_updated_at,
      collected_at, last_seen_at, excluded_at, excluded_reason, raw_payload
    ) values (
      p_owner_id, p_listing->>'source', p_listing->>'external_listing_id', p_listing->>'original_url', p_listing->>'normalized_url',
      p_listing->>'title', p_listing->>'description', (p_listing->>'price')::numeric, (p_listing->>'area')::numeric,
      (p_listing->>'price_per_sqm')::numeric, nullif(p_listing->>'rooms', '')::integer, p_listing->>'city', p_listing->>'district',
      p_listing->>'building_type', p_listing->>'market_type', p_listing->>'renovation_status', p_listing->>'content_hash',
      nullif(p_listing->>'cross_source_identity', ''), nullif(p_listing->>'published_at', '')::timestamptz,
      nullif(p_listing->>'source_updated_at', '')::timestamptz, (p_listing->>'collected_at')::timestamptz,
      (p_listing->>'last_seen_at')::timestamptz, inherited_excluded_at, inherited_excluded_reason, coalesce(p_listing->'raw_payload', '{}'::jsonb)
    ) returning id into saved_id;
  end if;
  return saved_id;
end;
$$;

create or replace function public.checkpoint_price_radar_run(
  p_owner_id uuid, p_run_id uuid, p_lease_token uuid, p_checkpoint jsonb, p_source_statuses jsonb,
  p_scanned_count integer, p_qualified_count integer, p_status text, p_error_message text,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 180 then raise exception 'invalid lease_seconds'; end if;
  update public.price_radar_runs r set checkpoint = p_checkpoint, source_statuses = p_source_statuses,
    scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = p_status,
    error_message = p_error_message,
    finished_at = case when p_status in ('completed', 'partial', 'failed') then now() else null end,
    lease_until = case when p_status in ('completed', 'partial', 'failed') then null else now() + make_interval(secs => p_lease_seconds) end,
    lease_token = case when p_status in ('completed', 'partial', 'failed') then null else r.lease_token end
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_lease_token and r.lease_until > now()
     and (r.stop_requested_at is null or (p_status = 'partial' and p_error_message = 'RADAR_STOPPED_BY_OPERATOR'));
  return found;
end;
$$;

create or replace function public.heartbeat_price_radar_olx_job(
  p_job_id uuid, p_worker_id text, p_job_lease_token uuid, p_radar_lease_token uuid, p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  job_context public.olx_scan_jobs%rowtype;
  radar_run public.price_radar_runs%rowtype;
  stopped_checkpoint jsonb;
  stopped_statuses jsonb;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then raise exception 'invalid lease_seconds'; end if;
  select * into job_context from public.olx_scan_jobs j
   where j.id = p_job_id and j.context_type = 'price_radar' and j.worker_id = p_worker_id
     and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token
     and j.status = 'running' and j.leased_until > now();
  if not found then return false; end if;
  select * into radar_run from public.price_radar_runs r
   where r.id = job_context.radar_run_id and r.owner_id = job_context.radar_owner_id
   for update;
  if not found then return false; end if;
  if radar_run.stop_requested_at is not null then
    stopped_checkpoint := jsonb_set(radar_run.checkpoint, '{sourceStatuses,olx}', '"pending"'::jsonb, true);
    stopped_statuses := jsonb_set(coalesce(radar_run.source_statuses, '{}'::jsonb), '{olx}', '"pending"'::jsonb, true);
    update public.price_radar_runs r set checkpoint = stopped_checkpoint, source_statuses = stopped_statuses,
      status = 'partial', error_message = 'RADAR_STOPPED_BY_OPERATOR', finished_at = now(),
      lease_token = null, lease_until = null
     where r.id = radar_run.id and r.owner_id = radar_run.owner_id and r.status = 'running'
       and r.lease_token = p_radar_lease_token and r.lease_until > now();
    if not found then return false; end if;
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR', error_message = 'Operator stopped this Radar run'
     where j.id = p_job_id and j.context_type = 'price_radar' and j.radar_owner_id = job_context.radar_owner_id
       and j.radar_run_id = job_context.radar_run_id and j.worker_id = p_worker_id
       and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token and j.status = 'running';
    return false;
  end if;
  if radar_run.status <> 'running' or radar_run.lease_token <> p_radar_lease_token or radar_run.lease_until <= now() then return false; end if;
  update public.olx_scan_jobs j set heartbeat_at = now(), leased_until = now() + make_interval(secs => p_lease_seconds)
   where j.id = p_job_id and j.context_type = 'price_radar' and j.worker_id = p_worker_id
     and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token
     and j.status = 'running' and j.leased_until > now();
  if not found then return false; end if;
  update public.price_radar_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
   where r.id = job_context.radar_run_id and r.owner_id = job_context.radar_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now() and r.stop_requested_at is null;
  if not found then raise exception 'RADAR_LEASE_LOST'; end if;
  return true;
end;
$$;

create or replace function public.finalize_price_radar_olx_job(
  p_owner_id uuid, p_run_id uuid, p_radar_lease_token uuid, p_job_id uuid, p_worker_id text, p_job_lease_token uuid,
  p_checkpoint jsonb, p_source_statuses jsonb, p_scanned_count integer, p_qualified_count integer,
  p_run_status text, p_error_message text, p_job_status text, p_result_summary jsonb, p_error_code text, p_job_error_message text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_run public.price_radar_runs%rowtype;
  stopped_checkpoint jsonb;
  stopped_statuses jsonb;
begin
  if jsonb_typeof(p_checkpoint) <> 'object' or jsonb_typeof(p_source_statuses) <> 'object'
    or p_scanned_count < 0 or p_qualified_count < 0
    or p_run_status not in ('running','completed','partial','failed')
    or p_job_status not in ('completed','failed') then raise exception 'invalid Radar OLX finalization'; end if;
  select * into current_run from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now()
   for update;
  if not found then return false; end if;

  if current_run.stop_requested_at is not null then
    stopped_checkpoint := jsonb_set(current_run.checkpoint, '{sourceStatuses,olx}', '"pending"'::jsonb, true);
    stopped_statuses := jsonb_set(coalesce(current_run.source_statuses, '{}'::jsonb), '{olx}', '"pending"'::jsonb, true);
    update public.price_radar_runs r set checkpoint = stopped_checkpoint, source_statuses = stopped_statuses,
      scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = 'partial',
      error_message = 'RADAR_STOPPED_BY_OPERATOR', finished_at = now(), lease_until = null, lease_token = null
     where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
       and r.lease_token = p_radar_lease_token and r.lease_until > now();
    if not found then return false; end if;
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR', error_message = 'Operator stopped this Radar run',
      result_summary = coalesce(j.result_summary, '{}'::jsonb) || jsonb_build_object('stopped_at', now(), 'stop_reason', 'operator_request')
     where j.id = p_job_id and j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id
       and j.radar_run_id = p_run_id and j.radar_lease_token = p_radar_lease_token
       and j.worker_id = p_worker_id and j.lease_token = p_job_lease_token and j.status = 'running' and j.leased_until > now();
    if not found then raise exception 'OLX_JOB_LEASE_LOST'; end if;
    return true;
  end if;

  update public.price_radar_runs r set checkpoint = p_checkpoint, source_statuses = p_source_statuses,
    scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = p_run_status,
    error_message = p_error_message,
    finished_at = case when p_run_status in ('completed','partial','failed') then now() else null end,
    lease_until = case when p_run_status in ('completed','partial','failed') then null else r.lease_until end,
    lease_token = case when p_run_status in ('completed','partial','failed') then null else r.lease_token end
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now() and r.stop_requested_at is null;
  if not found then return false; end if;
  update public.olx_scan_jobs j set status = p_job_status, finished_at = now(), leased_until = null,
    heartbeat_at = now(), result_summary = p_result_summary, error_code = p_error_code, error_message = p_job_error_message
   where j.id = p_job_id and j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id
     and j.radar_run_id = p_run_id and j.radar_lease_token = p_radar_lease_token
     and j.worker_id = p_worker_id and j.lease_token = p_job_lease_token and j.status = 'running' and j.leased_until > now();
  if not found then raise exception 'OLX_JOB_LEASE_LOST'; end if;
  return true;
end;
$$;

revoke all on function public.request_price_radar_run_stop(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_price_radar_run_stop(uuid, uuid) to service_role;

commit;
