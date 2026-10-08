begin;

-- LOCAL DRAFT ONLY. Do not apply as part of this mission. The Radar owns its
-- preferences, collection runs, exclusion state and listing snapshots. It
-- never writes canonical Finder listings or Finder memberships.
create table if not exists public.price_radar_settings (
  owner_id uuid primary key references auth.users(id) on delete restrict,
  filters jsonb not null default '{"districts":["Bałuty","Górna","Polesie","Śródmieście","Widzew"],"market":"both","areaMin":null,"areaMax":null,"rooms":[],"sources":[]}'::jsonb check (jsonb_typeof(filters) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.price_radar_listings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  source text not null check (source in ('otodom','olx','morizon','domiporta','sprzedajemy','adresowo','gratka','nieruchomosci_online','oferty_net','szybko','domy','allegro_lokalnie','official_cooperative','official_uml')),
  external_listing_id text not null,
  original_url text not null,
  normalized_url text not null,
  title text,
  description text,
  price numeric not null check (price > 0),
  area numeric not null check (area > 0),
  price_per_sqm numeric not null check (price_per_sqm > 0),
  rooms integer,
  city text not null,
  district text not null,
  building_type text not null check (building_type in ('blok', 'apartamentowiec')),
  market_type text not null check (market_type in ('primary', 'secondary')),
  renovation_status text not null check (renovation_status in ('fresh_renovation', 'turnkey_finish')),
  content_hash text not null,
  cross_source_identity text,
  published_at timestamptz,
  source_updated_at timestamptz,
  collected_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'removed')),
  excluded_at timestamptz,
  excluded_reason text,
  raw_payload jsonb not null default '{}'::jsonb,
  constraint price_radar_listings_owner_source_external_key unique (owner_id, source, external_listing_id),
  constraint price_radar_listings_owner_source_url_key unique (owner_id, source, normalized_url)
);

create index if not exists price_radar_listings_owner_district_market_idx
  on public.price_radar_listings (owner_id, district, market_type)
  where status = 'active';

create index if not exists price_radar_listings_owner_cross_identity_idx
  on public.price_radar_listings (owner_id, cross_source_identity)
  where cross_source_identity is not null and status = 'active';

create table if not exists public.price_radar_runs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed', 'partial')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checkpoint jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoint) = 'object'),
  source_statuses jsonb not null default '{}'::jsonb check (jsonb_typeof(source_statuses) = 'object'),
  lease_token uuid,
  lease_until timestamptz,
  scanned_count integer not null default 0 check (scanned_count >= 0),
  qualified_count integer not null default 0 check (qualified_count >= 0),
  error_message text
);

create unique index if not exists price_radar_runs_one_active_per_owner_idx
  on public.price_radar_runs (owner_id)
  where status in ('pending', 'running');

create index if not exists price_radar_runs_owner_latest_idx
  on public.price_radar_runs (owner_id, started_at desc);

-- The existing OLX browser worker remains the only OLX fetch path. Nullable
-- Finder references are permitted only for explicitly tagged Radar jobs.
alter table public.olx_scan_jobs
  alter column source_scan_id drop not null,
  alter column search_filter_id drop not null;
alter table public.olx_scan_jobs add column if not exists context_type text not null default 'finder';
alter table public.olx_scan_jobs add column if not exists radar_owner_id uuid references auth.users(id) on delete restrict;
alter table public.olx_scan_jobs add column if not exists radar_run_id uuid references public.price_radar_runs(id) on delete cascade;
alter table public.olx_scan_jobs add column if not exists radar_lease_token uuid;
alter table public.olx_scan_jobs drop constraint if exists olx_scan_jobs_context_check;
alter table public.olx_scan_jobs add constraint olx_scan_jobs_context_check check (
  (context_type = 'finder' and source_scan_id is not null and search_filter_id is not null and radar_owner_id is null and radar_run_id is null and radar_lease_token is null)
  or
  (context_type = 'price_radar' and source_scan_id is null and search_filter_id is null and radar_owner_id is not null and radar_run_id is not null and radar_lease_token is not null and scan_run_id = radar_run_id)
);

alter table public.price_radar_settings enable row level security;
alter table public.price_radar_listings enable row level security;
alter table public.price_radar_runs enable row level security;

revoke all on table public.price_radar_settings, public.price_radar_listings, public.price_radar_runs from anon;
revoke all on table public.price_radar_settings, public.price_radar_listings, public.price_radar_runs from authenticated;
grant select on table public.price_radar_settings, public.price_radar_listings, public.price_radar_runs to authenticated;
grant all on table public.price_radar_settings, public.price_radar_listings, public.price_radar_runs to service_role;

drop policy if exists price_radar_settings_owner_select on public.price_radar_settings;
create policy price_radar_settings_owner_select on public.price_radar_settings
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists price_radar_listings_owner_select on public.price_radar_listings;
create policy price_radar_listings_owner_select on public.price_radar_listings
  for select to authenticated using (owner_id = (select auth.uid()));
drop policy if exists price_radar_runs_owner_select on public.price_radar_runs;
create policy price_radar_runs_owner_select on public.price_radar_runs
  for select to authenticated using (owner_id = (select auth.uid()));

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
  -- A concurrent claim inserted the owner's active run first. The loser gets
  -- no token and must not perform any portal or database work.
  return;
end;
$$;

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

create or replace function public.set_price_radar_listing_exclusion(
  p_owner_id uuid, p_listing_id uuid, p_excluded boolean, p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  identity text;
begin
  select l.cross_source_identity into identity from public.price_radar_listings l
   where l.id = p_listing_id and l.owner_id = p_owner_id for update;
  if not found then return false; end if;
  update public.price_radar_listings l set
    excluded_at = case when p_excluded then coalesce(l.excluded_at, now()) else null end,
    excluded_reason = case when p_excluded then p_reason else null end
   where l.owner_id = p_owner_id and (l.id = p_listing_id or (identity is not null and l.cross_source_identity = identity));
  return true;
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
     and r.lease_token = p_lease_token and r.lease_until > now();
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
  job public.olx_scan_jobs%rowtype;
begin
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 300 then raise exception 'invalid lease_seconds'; end if;
  update public.olx_scan_jobs j set heartbeat_at = now(), leased_until = now() + make_interval(secs => p_lease_seconds)
   where j.id = p_job_id and j.context_type = 'price_radar' and j.worker_id = p_worker_id
     and j.lease_token = p_job_lease_token and j.radar_lease_token = p_radar_lease_token
     and j.status = 'running' and j.leased_until > now()
   returning j.* into job;
  if not found then return false; end if;
  update public.price_radar_runs r set lease_until = now() + make_interval(secs => p_lease_seconds)
   where r.id = job.radar_run_id and r.owner_id = job.radar_owner_id and r.status = 'running'
     and r.lease_token = job.radar_lease_token and r.lease_until > now();
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
begin
  if jsonb_typeof(p_checkpoint) <> 'object' or jsonb_typeof(p_source_statuses) <> 'object'
    or p_scanned_count < 0 or p_qualified_count < 0
    or p_run_status not in ('running','completed','partial','failed')
    or p_job_status not in ('completed','failed') then raise exception 'invalid Radar OLX finalization'; end if;
  update public.price_radar_runs r set checkpoint = p_checkpoint, source_statuses = p_source_statuses,
    scanned_count = p_scanned_count, qualified_count = p_qualified_count, status = p_run_status,
    error_message = p_error_message,
    finished_at = case when p_run_status in ('completed','partial','failed') then now() else null end,
    lease_until = case when p_run_status in ('completed','partial','failed') then null else r.lease_until end,
    lease_token = case when p_run_status in ('completed','partial','failed') then null else r.lease_token end
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status = 'running'
     and r.lease_token = p_radar_lease_token and r.lease_until > now();
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

revoke all on function public.claim_price_radar_run(uuid, jsonb, integer) from public, anon, authenticated;
revoke all on function public.persist_price_radar_listing(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_price_radar_listing_exclusion(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.checkpoint_price_radar_run(uuid, uuid, uuid, jsonb, jsonb, integer, integer, text, text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_price_radar_olx_job(uuid, text, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finalize_price_radar_olx_job(uuid, uuid, uuid, uuid, text, uuid, jsonb, jsonb, integer, integer, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.claim_price_radar_run(uuid, jsonb, integer) to service_role;
grant execute on function public.persist_price_radar_listing(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.set_price_radar_listing_exclusion(uuid, uuid, boolean, text) to service_role;
grant execute on function public.checkpoint_price_radar_run(uuid, uuid, uuid, jsonb, jsonb, integer, integer, text, text, integer) to service_role;
grant execute on function public.heartbeat_price_radar_olx_job(uuid, text, uuid, uuid, integer) to service_role;
grant execute on function public.finalize_price_radar_olx_job(uuid, uuid, uuid, uuid, text, uuid, jsonb, jsonb, integer, integer, text, text, text, jsonb, text, text) to service_role;

commit;
