begin;

-- LOCAL DRAFT ONLY. This queue is separate from the strict A/B comparison
-- sample and from the district-only queue. Do not apply to Production as
-- part of this task.
create table if not exists public.price_radar_verification_queue (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete restrict,
  source text not null check (source in (
    'otodom','olx','morizon','domiporta','sprzedajemy','adresowo','gratka',
    'nieruchomosci_online','oferty_net','szybko','domy','allegro_lokalnie',
    'official_cooperative','official_uml'
  )),
  external_listing_id text not null,
  original_url text not null,
  normalized_url text not null,
  title text,
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  confirmed_fields text[] not null default '{}',
  missing_fields text[] not null default '{}',
  contradictory_fields text[] not null default '{}',
  routing_reasons text[] not null default '{}',
  field_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(field_evidence) = 'object'),
  suggested_district text,
  suggestion_evidence text,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  operator_decision jsonb check (operator_decision is null or jsonb_typeof(operator_decision) = 'object'),
  decision_at timestamptz,
  decision_by uuid references auth.users(id) on delete restrict,
  rejected_at timestamptz,
  radar_listing_id uuid references public.price_radar_listings(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint price_radar_verification_queue_owner_source_external_key unique (owner_id, source, external_listing_id),
  constraint price_radar_verification_queue_owner_source_url_key unique (owner_id, source, normalized_url)
);

create index if not exists price_radar_verification_queue_owner_status_seen_idx
  on public.price_radar_verification_queue (owner_id, status, last_seen_at desc);

alter table public.price_radar_verification_queue enable row level security;
revoke all on table public.price_radar_verification_queue from public, anon, authenticated;
grant select on table public.price_radar_verification_queue to authenticated;
grant all on table public.price_radar_verification_queue to service_role;
drop policy if exists price_radar_verification_queue_owner_select on public.price_radar_verification_queue;
create policy price_radar_verification_queue_owner_select on public.price_radar_verification_queue
  for select to authenticated using (owner_id = (select auth.uid()));

create or replace function public.upsert_price_radar_verification_candidate(p_owner_id uuid, p_candidate jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_row public.price_radar_verification_queue%rowtype;
  candidate_source text := p_candidate->>'source';
  candidate_external_id text := nullif(btrim(p_candidate->>'external_listing_id'), '');
  candidate_url text := nullif(btrim(p_candidate->>'normalized_url'), '');
begin
  if p_owner_id is null or jsonb_typeof(p_candidate) <> 'object'
    or candidate_external_id is null or candidate_url is null
    or nullif(btrim(p_candidate->>'original_url'), '') is null
    or coalesce(candidate_source not in ('otodom','olx','morizon','domiporta','sprzedajemy','adresowo','gratka','nieruchomosci_online','oferty_net','szybko','domy','allegro_lokalnie','official_cooperative','official_uml'), true)
    or jsonb_typeof(coalesce(p_candidate->'source_snapshot','{}'::jsonb)) <> 'object'
    or (select u.id from auth.users u where u.id = p_owner_id) is null then
    raise exception 'INVALID_PRICE_RADAR_VERIFICATION_CANDIDATE';
  end if;

  select q.* into queue_row
    from public.price_radar_verification_queue q
   where q.owner_id = p_owner_id and q.source = candidate_source
     and (q.external_listing_id = candidate_external_id or q.normalized_url = candidate_url)
   order by (q.external_listing_id = candidate_external_id) desc, q.last_seen_at desc
   limit 1 for update;

  if found then
    update public.price_radar_verification_queue q set
      external_listing_id = candidate_external_id,
      original_url = p_candidate->>'original_url', normalized_url = candidate_url,
      title = nullif(p_candidate->>'title',''), source_snapshot = coalesce(p_candidate->'source_snapshot','{}'::jsonb),
      confirmed_fields = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'confirmed_fields','[]'::jsonb))), '{}'),
      missing_fields = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'missing_fields','[]'::jsonb))), '{}'),
      contradictory_fields = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'contradictory_fields','[]'::jsonb))), '{}'),
      routing_reasons = coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'routing_reasons','[]'::jsonb))), '{}'),
      field_evidence = coalesce(p_candidate->'field_evidence','{}'::jsonb),
      suggested_district = nullif(p_candidate->>'suggested_district',''),
      suggestion_evidence = nullif(p_candidate->>'suggestion_evidence',''),
      last_seen_at = coalesce(nullif(p_candidate->>'last_seen_at','')::timestamptz, now())
     where q.id = queue_row.id;
    return queue_row.id;
  end if;

  insert into public.price_radar_verification_queue (
    owner_id, source, external_listing_id, original_url, normalized_url, title,
    source_snapshot, confirmed_fields, missing_fields, contradictory_fields,
    routing_reasons, field_evidence, suggested_district, suggestion_evidence,
    first_seen_at, last_seen_at
  ) values (
    p_owner_id, candidate_source, candidate_external_id, p_candidate->>'original_url', candidate_url,
    nullif(p_candidate->>'title',''), coalesce(p_candidate->'source_snapshot','{}'::jsonb),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'confirmed_fields','[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'missing_fields','[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'contradictory_fields','[]'::jsonb))), '{}'),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_candidate->'routing_reasons','[]'::jsonb))), '{}'),
    coalesce(p_candidate->'field_evidence','{}'::jsonb), nullif(p_candidate->>'suggested_district',''),
    nullif(p_candidate->>'suggestion_evidence',''),
    coalesce(nullif(p_candidate->>'first_seen_at','')::timestamptz, now()),
    coalesce(nullif(p_candidate->>'last_seen_at','')::timestamptz, now())
  ) returning * into queue_row;
  return queue_row.id;
exception when unique_violation then
  select q.* into queue_row from public.price_radar_verification_queue q
   where q.owner_id = p_owner_id and q.source = candidate_source
     and (q.external_listing_id = candidate_external_id or q.normalized_url = candidate_url)
   order by (q.external_listing_id = candidate_external_id) desc, q.last_seen_at desc
   limit 1 for update;
  if not found then raise; end if;
  update public.price_radar_verification_queue q set last_seen_at = now() where q.id = queue_row.id;
  return queue_row.id;
end;
$$;

create or replace function public.set_price_radar_verification_queue_rejection(p_owner_id uuid, p_queue_id uuid, p_rejected boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_owner_id is null or p_queue_id is null or p_rejected is null then raise exception 'INVALID_PRICE_RADAR_VERIFICATION_DECISION'; end if;
  update public.price_radar_verification_queue q set
    status = case when p_rejected then 'rejected' else 'pending' end,
    rejected_at = case when p_rejected then coalesce(q.rejected_at, now()) else null end
   where q.owner_id = p_owner_id and q.id = p_queue_id and q.status in ('pending','rejected');
  return found;
end;
$$;

create or replace function public.resolve_price_radar_verification_candidate(p_owner_id uuid, p_queue_id uuid, p_operator_id uuid, p_decision jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_row public.price_radar_verification_queue%rowtype;
  saved_id uuid;
  price_value numeric := nullif(p_decision->>'price','')::numeric;
  area_value numeric := nullif(p_decision->>'area','')::numeric;
  rooms_value integer := nullif(p_decision->>'rooms','')::integer;
  district_value text := p_decision->>'district';
  building_value text := p_decision->>'buildingType';
  market_value text := p_decision->>'marketType';
  category_value text := p_decision->>'qualityCategory';
  renovation_value text;
  snapshot jsonb;
  decision_value jsonb;
begin
  if p_owner_id is null or p_queue_id is null or p_operator_id is distinct from p_owner_id
    or jsonb_typeof(p_decision) <> 'object' or p_decision->>'apartmentSaleConfirmed' <> 'true'
    or price_value is null or price_value <= 0 or area_value is null or area_value <= 0
    or rooms_value is null or rooms_value <= 0
    or p_decision->>'city' is distinct from 'Łódź'
    or coalesce(district_value not in ('Bałuty','Górna','Polesie','Śródmieście','Widzew'), true)
    or coalesce(building_value not in ('blok','apartamentowiec'), true)
    or coalesce(market_value not in ('primary','secondary'), true)
    or coalesce(category_value not in ('fresh_renovation','ready_high_standard'), true)
    or (category_value = 'fresh_renovation' and market_value <> 'secondary') then
    raise exception 'INVALID_PRICE_RADAR_VERIFICATION_DECISION';
  end if;
  renovation_value := case when category_value = 'fresh_renovation' then 'fresh_renovation' else 'turnkey_finish' end;

  select q.* into queue_row from public.price_radar_verification_queue q
   where q.id = p_queue_id and q.owner_id = p_owner_id and q.status in ('pending','confirmed') for update;
  if not found then raise exception 'PRICE_RADAR_VERIFICATION_CANDIDATE_NOT_FOUND'; end if;
  snapshot := queue_row.source_snapshot;
  decision_value := p_decision || jsonb_build_object('decisionAt', now(), 'decisionBy', p_operator_id);

  select l.id into saved_id from public.price_radar_listings l
   where l.owner_id = p_owner_id and l.source = queue_row.source
     and (l.external_listing_id = queue_row.external_listing_id or l.normalized_url = queue_row.normalized_url)
   order by (l.external_listing_id = queue_row.external_listing_id) desc, l.last_seen_at desc
   limit 1 for update;

  if saved_id is null then
    insert into public.price_radar_listings (
      owner_id, source, external_listing_id, original_url, normalized_url, title, description,
      price, area, price_per_sqm, rooms, city, district, building_type, market_type,
      renovation_status, content_hash, cross_source_identity, published_at, source_updated_at,
      collected_at, raw_payload
    ) values (
      p_owner_id, queue_row.source, queue_row.external_listing_id, queue_row.original_url, queue_row.normalized_url,
      queue_row.title, nullif(snapshot->>'description',''), price_value, area_value, price_value / area_value, rooms_value,
      p_decision->>'city', district_value, building_value, market_value, renovation_value,
      coalesce(nullif(snapshot->>'contentHash',''), md5(queue_row.source || ':' || queue_row.external_listing_id)),
      nullif(snapshot->>'crossSourceIdentity',''), nullif(snapshot->>'publishedAt','')::timestamptz,
      nullif(snapshot->>'sourceUpdatedAt','')::timestamptz, coalesce(nullif(snapshot->>'collectedAt','')::timestamptz, now()),
      jsonb_build_object('operatorVerification', decision_value, 'verificationQueueId', queue_row.id, 'sourceSnapshot', snapshot)
    ) returning id into saved_id;
  else
    update public.price_radar_listings l set
      external_listing_id = queue_row.external_listing_id, original_url = queue_row.original_url, normalized_url = queue_row.normalized_url,
      title = queue_row.title, description = nullif(snapshot->>'description',''), price = price_value, area = area_value,
      price_per_sqm = price_value / area_value, rooms = rooms_value, city = p_decision->>'city', district = district_value,
      building_type = building_value, market_type = market_value, renovation_status = renovation_value,
      content_hash = coalesce(nullif(snapshot->>'contentHash',''), l.content_hash),
      cross_source_identity = coalesce(nullif(snapshot->>'crossSourceIdentity',''), l.cross_source_identity),
      published_at = coalesce(nullif(snapshot->>'publishedAt','')::timestamptz, l.published_at),
      source_updated_at = coalesce(nullif(snapshot->>'sourceUpdatedAt','')::timestamptz, l.source_updated_at),
      collected_at = coalesce(nullif(snapshot->>'collectedAt','')::timestamptz, now()), last_seen_at = now(), status = 'active',
      raw_payload = coalesce(l.raw_payload,'{}'::jsonb) || jsonb_build_object('operatorVerification', decision_value, 'verificationQueueId', queue_row.id, 'sourceSnapshot', snapshot)
     where l.id = saved_id and l.owner_id = p_owner_id;
  end if;

  update public.price_radar_verification_queue q set status = 'confirmed', operator_decision = decision_value,
    decision_at = now(), decision_by = p_operator_id, rejected_at = null, radar_listing_id = saved_id
   where q.id = queue_row.id and q.owner_id = p_owner_id;
  return saved_id;
end;
$$;

revoke all on function public.upsert_price_radar_verification_candidate(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.set_price_radar_verification_queue_rejection(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.resolve_price_radar_verification_candidate(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_price_radar_verification_candidate(uuid, jsonb) to service_role;
grant execute on function public.set_price_radar_verification_queue_rejection(uuid, uuid, boolean) to service_role;
grant execute on function public.resolve_price_radar_verification_candidate(uuid, uuid, uuid, jsonb) to service_role;

commit;
