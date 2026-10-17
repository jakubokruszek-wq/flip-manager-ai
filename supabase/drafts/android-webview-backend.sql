-- Review-only schema proposal. NOT applied to any Supabase project.
-- After isolated PostgreSQL validation, promote using `supabase migration new`.
begin;
alter table public.collector_devices
  add column consumer_type text not null default 'BROWSER_EXTENSION'
  check (consumer_type in ('BROWSER_EXTENSION', 'ANDROID_WEBVIEW'));
alter table public.facebook_scan_jobs drop constraint facebook_scan_jobs_consumer_type_check;
alter table public.facebook_scan_jobs add constraint facebook_scan_jobs_consumer_type_check
  check (consumer_type in ('BROWSER_EXTENSION', 'LEGACY_WORKER', 'ANDROID_WEBVIEW'));
alter table public.facebook_scan_jobs add constraint facebook_android_source_scan_only
  check (consumer_type <> 'ANDROID_WEBVIEW' or (job_type = 'SOURCE_SCAN' and source_scan_id is not null));
alter table public.facebook_scan_jobs
  add column android_completion_id uuid,
  add column android_payload_hash text check (android_payload_hash is null or android_payload_hash ~ '^[a-f0-9]{64}$'),
  add column android_completion_state text check (android_completion_state in ('processing', 'settled')),
  add column android_completion_started_at timestamptz,
  add column android_receipt jsonb check (android_receipt is null or jsonb_typeof(android_receipt) = 'object'),
  add constraint facebook_android_completion_binding check (
    (android_completion_id is null and android_payload_hash is null and android_completion_state is null and android_completion_started_at is null and android_receipt is null)
    or (consumer_type = 'ANDROID_WEBVIEW' and job_type = 'SOURCE_SCAN'
        and android_completion_id is not null and android_payload_hash is not null
        and android_completion_started_at is not null and android_completion_state is not null
        and ((android_completion_state = 'processing' and status = 'running' and android_receipt is null)
          or (android_completion_state = 'settled' and status in ('completed', 'failed') and leased_until is null
              and android_receipt is not null and (android_receipt->>'status') is not distinct from status)))
  );
create unique index facebook_android_completion_id_idx on public.facebook_scan_jobs (android_completion_id)
  where android_completion_id is not null;
create index collector_devices_consumer_heartbeat_idx on public.collector_devices (consumer_type, last_heartbeat_at desc)
  where revoked_at is null;

-- Explicit device scope, empty by default. No automatic grant to every paired
-- phone and no fallback to all watched sources. Provision only after review.
create table public.collector_android_source_grants (
  device_id uuid not null references public.collector_devices(id) on delete cascade,
  watched_group_id uuid not null references public.watched_facebook_groups(id) on delete cascade,
  search_filter_id uuid not null,
  expires_at timestamptz,
  primary key (device_id, watched_group_id, search_filter_id)
);
alter table public.collector_android_source_grants enable row level security;
revoke all on public.collector_android_source_grants from public, anon, authenticated;
grant select, insert, update, delete on public.collector_android_source_grants to service_role;

-- The generic extension/legacy RPC is deliberately unchanged. It rejects
-- ANDROID_WEBVIEW; Android has its own recovery, device lock and source-only claim.
create function public.claim_android_facebook_scan_job(p_device_id uuid, p_lease_seconds integer default 180, p_source_ids uuid[] default null)
returns setof public.facebook_scan_jobs
language plpgsql security invoker set search_path = '' as $$
declare claimed public.facebook_scan_jobs%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then raise exception 'invalid lease duration'; end if;
  if cardinality(p_source_ids) > 50 then raise exception 'invalid source selection'; end if;
  if not exists (select 1 from public.collector_devices d where d.id = p_device_id and d.consumer_type = 'ANDROID_WEBVIEW' and d.revoked_at is null) then raise exception 'invalid Android device'; end if;
  -- Serializes polling from the same installation across backend processes.
  perform pg_advisory_xact_lock(hashtextextended('android-facebook:' || p_device_id::text, 0));
  -- Completion reservations never recover automatically: partially committed
  -- listing imports need reconciliation, not blind repeated side effects.
  if exists (select 1 from public.facebook_scan_jobs j where j.consumer_type = 'ANDROID_WEBVIEW'
             and j.worker_id = p_device_id::text and j.status = 'running' and j.android_completion_state = 'processing') then return; end if;
  select j.* into claimed from public.facebook_scan_jobs j
    where j.consumer_type = 'ANDROID_WEBVIEW' and j.job_type = 'SOURCE_SCAN' and j.status = 'running'
      and j.worker_id = p_device_id::text and j.leased_until > clock_timestamp()
    order by j.created_at limit 1 for update;
  if claimed.id is not null then
    if p_source_ids is null or claimed.group_snapshot->0->>'id' = any(p_source_ids::text[]) then return next claimed; end if;
    return;
  end if;

  with exhausted_candidates as (
    select j.id from public.facebook_scan_jobs j
    where j.consumer_type = 'ANDROID_WEBVIEW' and j.job_type = 'SOURCE_SCAN' and j.status = 'running'
      and j.leased_until <= clock_timestamp() and j.attempts >= j.max_attempts and j.android_completion_state is null
    order by j.leased_until, j.id limit 100 for update skip locked
  ), exhausted as (
    update public.facebook_scan_jobs j set status = 'failed', finished_at = clock_timestamp(), leased_until = null,
      lease_token = null, error_code = 'LEASE_EXHAUSTED', error_message = 'Android lease expired after maximum attempts'
    where j.id in (select id from exhausted_candidates)
    returning j.source_scan_id
  ) update public.source_scans s set status = 'failed', finished_at = clock_timestamp(), error_message = 'Android lease exhausted'
    where s.id in (select source_scan_id from exhausted) and s.status in ('pending', 'running');
  with recovery_candidates as (
    select j.id from public.facebook_scan_jobs j
    where j.consumer_type = 'ANDROID_WEBVIEW' and j.job_type = 'SOURCE_SCAN' and j.status = 'running'
      and j.leased_until <= clock_timestamp() and j.attempts < j.max_attempts and j.android_completion_state is null
    order by j.leased_until, j.id limit 100 for update skip locked
  )
  update public.facebook_scan_jobs j set status = 'queued',
    available_at = clock_timestamp() + make_interval(secs => least(300, 15 * power(2, least(greatest(j.attempts - 1, 0), 5))::integer + (abs(hashtext(j.id::text)::bigint) % 11)::integer)),
    leased_until = null,
    lease_token = null, worker_id = null, error_code = 'LEASE_RECOVERED', error_message = null
    where j.id in (select id from recovery_candidates);
  select j.* into claimed from public.facebook_scan_jobs j
    where j.consumer_type = 'ANDROID_WEBVIEW' and j.job_type = 'SOURCE_SCAN' and j.status = 'queued'
      and j.available_at <= clock_timestamp() and j.attempts < j.max_attempts and j.android_completion_state is null
      and (p_source_ids is null or j.group_snapshot->0->>'id' = any(p_source_ids::text[]))
      and exists (select 1 from public.collector_android_source_grants scope
        join public.watched_facebook_groups source on source.id = scope.watched_group_id
        where source.enabled = true and source.access_status in ('CONNECTED', 'MANUAL_IMPORT')
          and scope.device_id = p_device_id and scope.watched_group_id::text = j.group_snapshot->0->>'id'
          and scope.search_filter_id = j.search_filter_id
          and (scope.expires_at is null or scope.expires_at > clock_timestamp()))
    order by j.priority desc, j.created_at, j.id limit 1 for update skip locked;
  if claimed.id is null then return; end if;
  update public.facebook_scan_jobs j set status = 'running', attempts = j.attempts + 1, lease_token = gen_random_uuid(),
    leased_until = clock_timestamp() + make_interval(secs => p_lease_seconds), heartbeat_at = clock_timestamp(),
    worker_id = p_device_id::text, started_at = coalesce(j.started_at, clock_timestamp()), error_code = null, error_message = null
    where j.id = claimed.id returning j.* into claimed;
  update public.source_scans s set status = 'running', error_message = null where s.id = claimed.source_scan_id and s.status = 'pending';
  return next claimed;
end;
$$;

create function public.renew_android_facebook_scan_job(p_job_id uuid, p_device_id uuid, p_lease_token uuid, p_lease_seconds integer default 180)
returns table(job_id uuid, leased_until timestamptz)
language plpgsql security invoker set search_path = '' as $$
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then raise exception 'invalid lease duration'; end if;
  return query update public.facebook_scan_jobs j
    set heartbeat_at = clock_timestamp(), leased_until = clock_timestamp() + make_interval(secs => p_lease_seconds)
    where j.id = p_job_id and j.consumer_type = 'ANDROID_WEBVIEW' and j.job_type = 'SOURCE_SCAN'
      and j.worker_id = p_device_id::text and j.lease_token = p_lease_token and j.status = 'running'
      and j.leased_until > clock_timestamp()
      and exists (select 1 from public.collector_devices d where d.id = p_device_id and d.consumer_type = 'ANDROID_WEBVIEW' and d.revoked_at is null)
    returning j.id, j.leased_until;
end;
$$;

create function public.begin_android_facebook_completion(p_job_id uuid, p_device_id uuid, p_lease_token uuid, p_completion_id uuid, p_payload_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare j public.facebook_scan_jobs%rowtype;
begin
  if p_completion_id is null or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid completion'; end if;
  perform pg_advisory_xact_lock(hashtextextended('android-facebook:' || p_device_id::text, 0));
  select jobs.* into j from public.facebook_scan_jobs jobs where jobs.id = p_job_id for update;
  if j.id is null or j.consumer_type <> 'ANDROID_WEBVIEW' or j.job_type <> 'SOURCE_SCAN'
     or j.worker_id is distinct from p_device_id::text or j.lease_token is distinct from p_lease_token
     or not exists (select 1 from public.collector_devices d where d.id = p_device_id and d.consumer_type = 'ANDROID_WEBVIEW' and d.revoked_at is null)
     then return jsonb_build_object('outcome', 'lost'); end if;
  if j.android_completion_id is not null then
    if j.android_completion_id <> p_completion_id or j.android_payload_hash <> p_payload_hash then return jsonb_build_object('outcome', 'conflict'); end if;
    if j.android_completion_state = 'settled' then return jsonb_build_object('outcome', 'duplicate', 'receipt', j.android_receipt); end if;
    return jsonb_build_object('outcome', 'busy');
  end if;
  if j.status <> 'running' or j.leased_until is null or j.leased_until <= clock_timestamp() then return jsonb_build_object('outcome', 'lost'); end if;
  if exists (select 1 from public.facebook_scan_jobs other where other.android_completion_id = p_completion_id) then return jsonb_build_object('outcome', 'conflict'); end if;
  update public.facebook_scan_jobs jobs set android_completion_id = p_completion_id, android_payload_hash = p_payload_hash,
    android_completion_state = 'processing', android_completion_started_at = clock_timestamp()
    where jobs.id = j.id;
  return jsonb_build_object('outcome', 'reserved');
exception when unique_violation then return jsonb_build_object('outcome', 'conflict');
end;
$$;

create function public.finish_android_facebook_completion(p_job_id uuid, p_device_id uuid, p_lease_token uuid, p_completion_id uuid, p_payload_hash text, p_receipt jsonb, p_error_code text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare scan_id uuid; final_status text; existing public.facebook_scan_jobs%rowtype;
begin
  final_status := p_receipt->>'status';
  if final_status is null or final_status not in ('completed', 'failed') or jsonb_typeof(p_receipt) <> 'object'
    or p_receipt->'ok' is distinct from 'true'::jsonb or not (p_receipt ? 'result')
    or p_receipt->>'completionId' is distinct from p_completion_id::text then raise exception 'invalid receipt'; end if;
  -- Retry of a committed finalization must return its original receipt.
  select j.* into existing from public.facebook_scan_jobs j where j.id = p_job_id for update;
  if existing.consumer_type = 'ANDROID_WEBVIEW' and existing.job_type = 'SOURCE_SCAN'
    and existing.worker_id = p_device_id::text and existing.lease_token = p_lease_token
    and existing.android_completion_id = p_completion_id and existing.android_payload_hash = p_payload_hash
    and existing.android_completion_state = 'settled'
    and exists (select 1 from public.collector_devices d where d.id = p_device_id and d.consumer_type = 'ANDROID_WEBVIEW' and d.revoked_at is null)
    then return existing.android_receipt; end if;
  -- Lease expiry after begin is allowed: reservation fences all replacement
  -- workers. Exact owner/token/hash/state remain mandatory.
  update public.facebook_scan_jobs j set status = final_status, finished_at = clock_timestamp(), leased_until = null,
    android_completion_state = 'settled', android_receipt = p_receipt, result_summary = p_receipt,
    error_code = case when final_status = 'failed' then left(coalesce(p_error_code, 'ANDROID_FAILED'), 100) else null end,
    error_message = case when final_status = 'failed' then left(coalesce(p_error_code, 'ANDROID_FAILED'), 100) else null end
    where j.id = p_job_id and j.consumer_type = 'ANDROID_WEBVIEW' and j.job_type = 'SOURCE_SCAN' and j.status = 'running'
      and j.worker_id = p_device_id::text and j.lease_token = p_lease_token
      and j.android_completion_id = p_completion_id and j.android_payload_hash = p_payload_hash and j.android_completion_state = 'processing'
      and exists (select 1 from public.collector_devices d where d.id = p_device_id and d.consumer_type = 'ANDROID_WEBVIEW' and d.revoked_at is null)
    returning j.source_scan_id into scan_id;
  if scan_id is null then return null; end if;
  update public.source_scans s set status = final_status, finished_at = clock_timestamp(),
    error_message = case when final_status = 'failed' then left(coalesce(p_error_code, 'ANDROID_FAILED'), 100) else null end
    where s.id = scan_id and s.status in ('pending', 'running');
  return p_receipt;
end;
$$;
revoke all on function public.claim_android_facebook_scan_job(uuid, integer, uuid[]) from public, anon, authenticated;
revoke all on function public.renew_android_facebook_scan_job(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.begin_android_facebook_completion(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_android_facebook_completion(uuid, uuid, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.claim_android_facebook_scan_job(uuid, integer, uuid[]) to service_role;
grant execute on function public.renew_android_facebook_scan_job(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.begin_android_facebook_completion(uuid, uuid, uuid, uuid, text) to service_role;
grant execute on function public.finish_android_facebook_completion(uuid, uuid, uuid, uuid, text, jsonb, text) to service_role;
commit;
