-- Versioned current-deal writes. Immutable Investment OS history is unchanged.
alter table public.deals
  add column if not exists version integer not null default 1 check (version > 0),
  add column if not exists source_updated_at timestamptz;

create or replace function public.persist_investment_deal_cas(
  p_deal jsonb,
  p_expected_version integer,
  p_source_updated_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deal_id uuid;
  v_listing_id uuid;
  v_version integer;
begin
  if p_deal is null or jsonb_typeof(p_deal) <> 'object' or p_expected_version is null or p_expected_version < 0 then
    raise exception 'INVESTMENT_DEAL_WRITE_INVALID';
  end if;

  v_deal_id := nullif(p_deal->>'id', '')::uuid;
  v_listing_id := nullif(p_deal->>'listing_id', '')::uuid;
  if v_deal_id is null or v_listing_id is null then
    raise exception 'INVESTMENT_DEAL_WRITE_INVALID';
  end if;

  -- The source snapshot must still be current at the instant the write commits.
  if not exists (
    select 1 from public.listings l
    where l.id = v_listing_id and l.updated_at is not distinct from p_source_updated_at
  ) then
    return null;
  end if;

  if p_expected_version = 0 then
    insert into public.deals (
      id, listing_id, stage, facts_fingerprint, facts, scout, verify, market,
      underwriting, ceo, playbook, evidence_fabric, information_requests,
      analysis_level, created_at, updated_at, version, source_updated_at
    ) values (
      v_deal_id, v_listing_id, p_deal->>'stage', p_deal->>'facts_fingerprint',
      coalesce(p_deal->'facts', '{}'::jsonb), coalesce(p_deal->'scout', '{}'::jsonb),
      coalesce(p_deal->'verify', '{}'::jsonb), coalesce(p_deal->'market', '{}'::jsonb),
      coalesce(p_deal->'underwriting', '{}'::jsonb), coalesce(p_deal->'ceo', '{}'::jsonb),
      coalesce(p_deal->'playbook', '{}'::jsonb), coalesce(p_deal->'evidence_fabric', '[]'::jsonb),
      coalesce(p_deal->'information_requests', '[]'::jsonb),
      coalesce((p_deal->>'analysis_level')::integer, 1),
      coalesce((p_deal->>'created_at')::timestamptz, now()), now(), 1, p_source_updated_at
    )
    on conflict (listing_id) do nothing
    returning version into v_version;
    return v_version;
  end if;

  update public.deals d
  set stage = p_deal->>'stage',
      facts_fingerprint = p_deal->>'facts_fingerprint',
      facts = coalesce(p_deal->'facts', '{}'::jsonb),
      scout = coalesce(p_deal->'scout', '{}'::jsonb),
      verify = coalesce(p_deal->'verify', '{}'::jsonb),
      market = coalesce(p_deal->'market', '{}'::jsonb),
      underwriting = coalesce(p_deal->'underwriting', '{}'::jsonb),
      ceo = coalesce(p_deal->'ceo', '{}'::jsonb),
      playbook = coalesce(p_deal->'playbook', '{}'::jsonb),
      evidence_fabric = coalesce(p_deal->'evidence_fabric', '[]'::jsonb),
      information_requests = coalesce(p_deal->'information_requests', '[]'::jsonb),
      analysis_level = coalesce((p_deal->>'analysis_level')::integer, 1),
      source_updated_at = p_source_updated_at,
      version = d.version + 1,
      updated_at = now()
  where d.id = v_deal_id
    and d.listing_id = v_listing_id
    and d.version = p_expected_version
    and exists (
      select 1 from public.listings l
      where l.id = d.listing_id and l.updated_at is not distinct from p_source_updated_at
    )
  returning d.version into v_version;

  return v_version;
end;
$$;

-- Any projection/status invalidation increments the same CAS version.
create or replace function public.mark_investment_deal_stale_cas(
  p_deal_id uuid,
  p_expected_version integer,
  p_directors text[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_version integer;
begin
  if p_deal_id is null or p_expected_version is null or p_expected_version < 1
     or coalesce(cardinality(p_directors), 0) = 0
     or exists (select 1 from unnest(p_directors) d where d not in ('MARKET','UNDERWRITER','CEO')) then
    raise exception 'INVESTMENT_DEAL_STALE_INVALID';
  end if;

  update public.deals d
  set market = case when 'MARKET' = any(p_directors) then jsonb_set(coalesce(d.market, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.market end,
      underwriting = case when 'UNDERWRITER' = any(p_directors) then jsonb_set(coalesce(d.underwriting, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.underwriting end,
      ceo = case when 'CEO' = any(p_directors) then jsonb_set(coalesce(d.ceo, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.ceo end,
      version = d.version + 1,
      updated_at = now()
  where d.id = p_deal_id and d.version = p_expected_version
  returning d.version into v_version;
  return v_version;
end;
$$;

-- The override projection, version bump, and append-only event are one transaction.
drop function if exists public.apply_investment_override(uuid, jsonb, text[], jsonb, text);
create function public.apply_investment_override_cas(
  p_deal_id uuid,
  p_expected_version integer,
  p_values jsonb,
  p_invalidated text[] default '{}',
  p_events jsonb default '[]'::jsonb,
  p_user_id text default 'application'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_version integer;
begin
  if p_deal_id is null or p_expected_version is null or p_expected_version < 1
     or jsonb_typeof(coalesce(p_values, '{}'::jsonb)) <> 'object' then
    raise exception 'INVESTMENT_OVERRIDE_INVALID';
  end if;

  update public.deals d
  set verify = case when 'VERIFY' = any(p_invalidated) then jsonb_set(coalesce(d.verify, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.verify end,
      market = case when 'MARKET' = any(p_invalidated) then jsonb_set(coalesce(d.market, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.market end,
      underwriting = case when 'UNDERWRITER' = any(p_invalidated) then jsonb_set(coalesce(d.underwriting, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.underwriting end,
      ceo = case when 'CEO' = any(p_invalidated) then jsonb_set(coalesce(d.ceo, '{}'::jsonb), '{status}', '"STALE"'::jsonb, true) else d.ceo end,
      version = d.version + 1,
      updated_at = now()
  where d.id = p_deal_id and d.version = p_expected_version
  returning d.version into v_version;

  if v_version is null then
    raise exception using errcode = 'P0001', message = 'INVESTMENT_DEAL_VERSION_CONFLICT';
  end if;

  insert into public.deal_fact_overrides(deal_id, values, updated_at)
  values (p_deal_id, coalesce(p_values, '{}'::jsonb), now())
  on conflict (deal_id) do update set values = excluded.values, updated_at = now();

  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) = 'array' then
    insert into public.deal_fact_override_events(deal_id, field, override_value, source_evidence_ids, conflict_status, user_id, confirmation_reason, confirmed_at, content_hash)
    select p_deal_id, left(entry->>'field', 120), entry->'overrideValue', coalesce(entry->'sourceEvidenceIds', '[]'::jsonb),
      case when entry->>'conflictStatus' in ('NONE','CRITICAL') then entry->>'conflictStatus' else 'NONE' end,
      left(coalesce(nullif(p_user_id, ''), 'application'), 200), null, null, left(coalesce(entry->>'contentHash', md5(entry::text)), 200)
    from jsonb_array_elements(p_events) as entry
    where jsonb_typeof(entry) = 'object' and nullif(entry->>'field', '') is not null
    on conflict (deal_id, field, content_hash) do nothing;
  end if;
  return v_version;
end;
$$;

revoke all on function public.persist_investment_deal_cas(jsonb, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.mark_investment_deal_stale_cas(uuid, integer, text[]) from public, anon, authenticated;
revoke all on function public.apply_investment_override_cas(uuid, integer, jsonb, text[], jsonb, text) from public, anon, authenticated;
grant execute on function public.persist_investment_deal_cas(jsonb, integer, timestamptz) to service_role;
grant execute on function public.mark_investment_deal_stale_cas(uuid, integer, text[]) to service_role;
grant execute on function public.apply_investment_override_cas(uuid, integer, jsonb, text[], jsonb, text) to service_role;
