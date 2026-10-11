begin;

-- DRAFT. Prepared and dry-run tested inside a rolled-back transaction
-- (see this mission's final report for the exact verification queries and
-- their output) against the real linked Production schema. Not applied as
-- part of this mission; application code must keep working with this
-- migration unapplied (detects a missing relation via PostgREST/Postgres
-- error codes and degrades to "queue unavailable", exactly like the
-- existing year_built/identity_evidence optional-column pattern).
--
-- Holds Radar candidates that are fully qualified on every criterion
-- EXCEPT a confirmed district -- never a second collection pipeline, never
-- written to by anything other than this app's own server code. An
-- operator's district choice (or rejection) here never touches Finder,
-- Watcher, CRM, or canonical listings; it only ever writes this table and,
-- once assigned, the SAME price_radar_listings table a normal qualified
-- scan result already writes to.
create table if not exists public.price_radar_district_queue (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  source text not null check (source in ('otodom','olx','morizon','domiporta','sprzedajemy','adresowo','gratka','nieruchomosci_online','oferty_net','domy','allegro_lokalnie','official_cooperative','official_uml')),
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
  -- Every OTHER Radar criterion is already confirmed before a row is ever
  -- inserted here (see assessRadarDistrictOnlyCandidate); only the
  -- district itself is intentionally left unset.
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
  raw_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'assigned', 'rejected')),
  -- A best-effort automated guess at the missing district, shown to the
  -- operator as a prefilled suggestion -- never auto-applied, and never
  -- counted toward the A/B sample until the operator confirms it (or a
  -- different district) via assign_price_radar_district_queue_candidate.
  -- Recomputed by application code only when content_hash changes (see
  -- upsertPendingDistrictCandidate), so an unchanged reimport never
  -- re-invokes the GIS/AI lookup that produced it.
  suggested_district text check (suggested_district is null or suggested_district in ('Bałuty','Górna','Polesie','Śródmieście','Widzew')),
  suggestion_source text check (suggestion_source is null or suggestion_source in ('gis', 'ai')),
  suggestion_evidence text,
  assigned_district text check (assigned_district is null or assigned_district in ('Bałuty','Górna','Polesie','Śródmieście','Widzew')),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz,
  assignment_origin text,
  rejected_at timestamptz,
  -- Set once an assignment promotes this candidate into price_radar_listings.
  -- Kept even after a later correction (re-assign to a different district
  -- updates the same listings row); never cleared by a reject/restore cycle
  -- that happens before any assignment at all.
  radar_listing_id uuid references public.price_radar_listings(id) on delete set null,
  constraint price_radar_district_queue_owner_source_external_key unique (owner_id, source, external_listing_id)
);

create index if not exists price_radar_district_queue_owner_status_idx
  on public.price_radar_district_queue (owner_id, status);

alter table public.price_radar_district_queue enable row level security;
revoke all on table public.price_radar_district_queue from anon;
revoke all on table public.price_radar_district_queue from authenticated;
grant select on table public.price_radar_district_queue to authenticated;
grant all on table public.price_radar_district_queue to service_role;

drop policy if exists price_radar_district_queue_owner_select on public.price_radar_district_queue;
create policy price_radar_district_queue_owner_select on public.price_radar_district_queue
  for select to authenticated using (owner_id = (select auth.uid()));

-- Idempotent upsert for a scan-discovered, district-only-missing candidate.
-- Called from the normal collection path (collect.ts, the OLX worker) --
-- never a second scraper. A re-scan of the same (owner, source,
-- external_listing_id) refreshes the dwelling snapshot but must never
-- silently overwrite an operator's own prior decision: status, the
-- assigned district, and the linked price_radar_listings row all survive
-- a reimport/price-change untouched once a decision has been made.
create or replace function public.upsert_price_radar_district_queue_candidate(
  p_owner_id uuid, p_candidate jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing public.price_radar_district_queue%rowtype;
  saved_id uuid;
begin
  select * into existing from public.price_radar_district_queue q
   where q.owner_id = p_owner_id and q.source = p_candidate->>'source' and q.external_listing_id = p_candidate->>'external_listing_id'
   for update;

  if found then
    update public.price_radar_district_queue q set
      original_url = p_candidate->>'original_url', normalized_url = p_candidate->>'normalized_url',
      title = p_candidate->>'title', description = p_candidate->>'description',
      price = (p_candidate->>'price')::numeric, area = (p_candidate->>'area')::numeric, price_per_sqm = (p_candidate->>'price_per_sqm')::numeric,
      rooms = nullif(p_candidate->>'rooms', '')::integer, city = p_candidate->>'city',
      building_type = p_candidate->>'building_type', market_type = p_candidate->>'market_type', renovation_status = p_candidate->>'renovation_status',
      content_hash = p_candidate->>'content_hash', cross_source_identity = nullif(p_candidate->>'cross_source_identity', ''),
      published_at = nullif(p_candidate->>'published_at', '')::timestamptz, source_updated_at = nullif(p_candidate->>'source_updated_at', '')::timestamptz,
      collected_at = (p_candidate->>'collected_at')::timestamptz, last_seen_at = (p_candidate->>'last_seen_at')::timestamptz,
      raw_payload = coalesce(p_candidate->'raw_payload', '{}'::jsonb),
      -- The caller (upsertPendingDistrictCandidate) already decided
      -- whether to recompute these: it passes the PRIOR row's own values
      -- back unchanged when content_hash is the same, so this is always a
      -- plain overwrite here, never a conditional skip in SQL.
      suggested_district = nullif(p_candidate->>'suggested_district', ''),
      suggestion_source = nullif(p_candidate->>'suggestion_source', ''),
      suggestion_evidence = nullif(p_candidate->>'suggestion_evidence', '')
      -- status/assigned_*/rejected_at/radar_listing_id intentionally
      -- untouched: a rescan must never silently reopen or discard a
      -- decision the operator already made.
    where q.id = existing.id
    returning q.id into saved_id;
  else
    insert into public.price_radar_district_queue (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description,
      price, area, price_per_sqm, rooms, city, building_type, market_type, renovation_status,
      content_hash, cross_source_identity, published_at, source_updated_at, collected_at, last_seen_at, raw_payload,
      suggested_district, suggestion_source, suggestion_evidence
    ) values (
      p_owner_id, p_candidate->>'source', p_candidate->>'external_listing_id', p_candidate->>'original_url', p_candidate->>'normalized_url',
      p_candidate->>'title', p_candidate->>'description', (p_candidate->>'price')::numeric, (p_candidate->>'area')::numeric, (p_candidate->>'price_per_sqm')::numeric,
      nullif(p_candidate->>'rooms', '')::integer, p_candidate->>'city', p_candidate->>'building_type', p_candidate->>'market_type', p_candidate->>'renovation_status',
      p_candidate->>'content_hash', nullif(p_candidate->>'cross_source_identity', ''), nullif(p_candidate->>'published_at', '')::timestamptz,
      nullif(p_candidate->>'source_updated_at', '')::timestamptz, (p_candidate->>'collected_at')::timestamptz, (p_candidate->>'last_seen_at')::timestamptz,
      coalesce(p_candidate->'raw_payload', '{}'::jsonb),
      nullif(p_candidate->>'suggested_district', ''), nullif(p_candidate->>'suggestion_source', ''), nullif(p_candidate->>'suggestion_evidence', '')
    ) returning id into saved_id;
  end if;
  return saved_id;
end;
$$;

-- Promotes a pending (or previously assigned, for a correction) candidate
-- into price_radar_listings under the operator-chosen district, in the
-- same transaction as recording the decision -- a partial write (queue
-- marked assigned but no listing row, or the reverse) must be impossible.
-- The caller (application code) has already re-run the full qualification
-- with this district filled in and only calls this with an already-
-- confirmed building_type/market_type/renovation_status/price_per_sqm;
-- this function trusts and persists exactly those values, the same
-- contract persist_price_radar_listing already has for a normal scan.
create or replace function public.assign_price_radar_district_queue_candidate(
  p_owner_id uuid, p_queue_id uuid, p_district text, p_assigned_by uuid, p_confirmed jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  queue_row public.price_radar_district_queue%rowtype;
  existing_id uuid;
  saved_id uuid;
  inherited_excluded_at timestamptz;
  inherited_excluded_reason text;
begin
  if p_district not in ('Bałuty','Górna','Polesie','Śródmieście','Widzew') then
    raise exception 'INVALID_DISTRICT';
  end if;

  select * into queue_row from public.price_radar_district_queue q
   where q.id = p_queue_id and q.owner_id = p_owner_id for update;
  if not found then raise exception 'QUEUE_CANDIDATE_NOT_FOUND'; end if;

  select l.id into existing_id from public.price_radar_listings l
   where l.owner_id = p_owner_id and l.source = queue_row.source
     and (l.external_listing_id = queue_row.external_listing_id or l.normalized_url = queue_row.normalized_url)
   order by (l.external_listing_id = queue_row.external_listing_id) desc, l.last_seen_at desc
   limit 1 for update;

  if nullif(queue_row.cross_source_identity, '') is not null then
    select l.excluded_at, l.excluded_reason into inherited_excluded_at, inherited_excluded_reason
      from public.price_radar_listings l
     where l.owner_id = p_owner_id and l.cross_source_identity = queue_row.cross_source_identity and l.excluded_at is not null
     order by l.excluded_at desc limit 1 for update;
  end if;

  if existing_id is not null then
    update public.price_radar_listings l set
      external_listing_id = queue_row.external_listing_id, original_url = queue_row.original_url, normalized_url = queue_row.normalized_url,
      title = queue_row.title, description = queue_row.description, price = queue_row.price, area = queue_row.area, price_per_sqm = (p_confirmed->>'price_per_sqm')::numeric,
      rooms = queue_row.rooms, city = queue_row.city, district = p_district,
      building_type = p_confirmed->>'building_type', market_type = p_confirmed->>'market_type', renovation_status = p_confirmed->>'renovation_status',
      content_hash = queue_row.content_hash, cross_source_identity = nullif(queue_row.cross_source_identity, ''),
      published_at = queue_row.published_at, source_updated_at = queue_row.source_updated_at,
      collected_at = queue_row.collected_at, last_seen_at = queue_row.last_seen_at,
      excluded_at = coalesce(l.excluded_at, inherited_excluded_at), excluded_reason = coalesce(l.excluded_reason, inherited_excluded_reason),
      status = 'active', raw_payload = queue_row.raw_payload
    where l.id = existing_id returning l.id into saved_id;
  else
    insert into public.price_radar_listings (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description, price, area, price_per_sqm, rooms,
      city, district, building_type, market_type, renovation_status, content_hash, cross_source_identity, published_at, source_updated_at,
      collected_at, last_seen_at, excluded_at, excluded_reason, raw_payload
    ) values (
      p_owner_id, queue_row.source, queue_row.external_listing_id, queue_row.original_url, queue_row.normalized_url,
      queue_row.title, queue_row.description, queue_row.price, queue_row.area, (p_confirmed->>'price_per_sqm')::numeric, queue_row.rooms,
      queue_row.city, p_district, p_confirmed->>'building_type', p_confirmed->>'market_type', p_confirmed->>'renovation_status', queue_row.content_hash,
      nullif(queue_row.cross_source_identity, ''), queue_row.published_at, queue_row.source_updated_at,
      queue_row.collected_at, queue_row.last_seen_at, inherited_excluded_at, inherited_excluded_reason, queue_row.raw_payload
    ) returning id into saved_id;
  end if;

  update public.price_radar_district_queue q set
    status = 'assigned', assigned_district = p_district, assigned_by = p_assigned_by, assigned_at = now(),
    assignment_origin = 'dzielnica przypisana ręcznie', rejected_at = null, radar_listing_id = saved_id
   where q.id = p_queue_id;

  return saved_id;
end;
$$;

-- Reject / undo-reject. Never touches price_radar_listings -- a rejection
-- before any assignment has no linked listing row to begin with, and this
-- function is deliberately never used to un-assign an already-promoted
-- listing (re-assigning to a different district, not rejecting, is the
-- documented correction path for that case).
create or replace function public.set_price_radar_district_queue_rejection(
  p_owner_id uuid, p_queue_id uuid, p_rejected boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.price_radar_district_queue q set
    status = case when p_rejected then 'rejected' else 'pending' end,
    rejected_at = case when p_rejected then now() else null end
   where q.id = p_queue_id and q.owner_id = p_owner_id and q.status in ('pending', 'rejected');
  return found;
end;
$$;

revoke all on function public.upsert_price_radar_district_queue_candidate(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.assign_price_radar_district_queue_candidate(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_price_radar_district_queue_rejection(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.upsert_price_radar_district_queue_candidate(uuid, jsonb) to service_role;
grant execute on function public.assign_price_radar_district_queue_candidate(uuid, uuid, text, uuid, jsonb) to service_role;
grant execute on function public.set_price_radar_district_queue_rejection(uuid, uuid, boolean) to service_role;

commit;
