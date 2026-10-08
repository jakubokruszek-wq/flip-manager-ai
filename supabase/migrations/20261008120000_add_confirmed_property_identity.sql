begin;

-- No title/price/area/address/image-based backfill is intentional: existing
-- listings remain separate until a source or operator supplies confirmed
-- stable identity evidence. These nullable fields preserve every source row.
alter table public.listings
  add column if not exists cross_source_identity text;
alter table public.properties
  add column if not exists cross_source_identity text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'listings_cross_source_identity_format_check' and conrelid = 'public.listings'::regclass) then
    alter table public.listings add constraint listings_cross_source_identity_format_check
      check (cross_source_identity is null or cross_source_identity ~ '^(canonical_unit_id|portal_shared_unit_id):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'properties_cross_source_identity_format_check' and conrelid = 'public.properties'::regclass) then
    alter table public.properties add constraint properties_cross_source_identity_format_check
      check (cross_source_identity is null or cross_source_identity ~ '^(canonical_unit_id|portal_shared_unit_id):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'price_radar_listings_cross_source_identity_format_check' and conrelid = 'public.price_radar_listings'::regclass) then
    alter table public.price_radar_listings add constraint price_radar_listings_cross_source_identity_format_check
      check (cross_source_identity is null or cross_source_identity ~ '^(canonical_unit_id|portal_shared_unit_id):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$');
  end if;
end;
$$;

create index if not exists listings_cross_source_identity_idx
  on public.listings (cross_source_identity, source, id)
  where cross_source_identity is not null;

-- CRM is a single-operator workspace. A confirmed unit identity can point to
-- at most one CRM property, while its individual source listings remain intact.
create unique index if not exists properties_cross_source_identity_key
  on public.properties (cross_source_identity)
  where cross_source_identity is not null;

create or replace function public.apply_confirmed_property_group_review_decision(
  p_listing_id uuid,
  p_decision text,
  p_reason text default null,
  p_now timestamptz default now()
)
returns table(listing_id uuid, decision text, lifecycle_status text, membership_count bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_identity text;
  member_ids uuid[];
  normalized_decision text := upper(trim(coalesce(p_decision, '')));
  normalized_reason text := nullif(trim(p_reason), '');
  affected_memberships bigint := 0;
begin
  if normalized_decision not in ('ACCEPTED', 'REJECTED') then
    raise exception 'LISTING_REVIEW_INVALID_DECISION' using errcode = '22023';
  end if;
  if normalized_reason is not null and char_length(normalized_reason) > 500 then
    raise exception 'LISTING_REVIEW_REASON_TOO_LONG' using errcode = '22023';
  end if;

  select l.cross_source_identity into target_identity
  from public.listings l where l.id = p_listing_id for update;
  if not found then raise exception 'LISTING_REVIEW_NOT_FOUND' using errcode = 'P0002'; end if;

  if target_identity is null then
    return query select * from public.apply_listing_review_decision(p_listing_id, normalized_decision, normalized_reason, p_now);
    return;
  end if;

  select array_agg(id order by id) into member_ids
  from (select l.id from public.listings l where l.cross_source_identity = target_identity order by l.id for update) members;
  if coalesce(cardinality(member_ids), 0) < 2 then
    return query select * from public.apply_listing_review_decision(p_listing_id, normalized_decision, normalized_reason, p_now);
    return;
  end if;
  if exists (
    select 1 from public.listings l where l.id = any(member_ids)
      and (l.lifecycle_status in ('STALE', 'ARCHIVED', 'REJECTED')
        or (normalized_decision = 'ACCEPTED' and l.manual_decision = 'REJECTED')
        or (normalized_decision = 'REJECTED' and l.manual_decision = 'ACCEPTED'))
  ) then
    raise exception 'LISTING_REVIEW_GROUP_INVALID_TRANSITION' using errcode = 'P0001';
  end if;

  if normalized_decision = 'ACCEPTED' then
    update public.listings l set lifecycle_status = 'ACTIVE', manual_decision = 'ACCEPTED',
      manual_decision_reason = normalized_reason, review_reason = null, missing_fields = '[]'::jsonb,
      archived_at = null, status = 'active'
    where l.id = any(member_ids);
    update public.listing_filter_matches m set is_current_match = true, last_matched_at = p_now,
      match_reasons = jsonb_build_array('manual_accept') || coalesce((
        select jsonb_agg(r.value order by r.position)
        from jsonb_array_elements_text(coalesce(m.match_reasons, '[]'::jsonb)) with ordinality r(value, position)
        where r.value <> 'manual_accept' and r.value <> 'review' and r.value not like 'unknown\_%' escape '\'
      ), '[]'::jsonb)
    where m.listing_id = any(member_ids);
  else
    update public.listings l set lifecycle_status = 'REJECTED', manual_decision = 'REJECTED',
      manual_decision_reason = normalized_reason, review_reason = null, missing_fields = '[]'::jsonb,
      archived_at = coalesce(l.archived_at, p_now)
    where l.id = any(member_ids);
    update public.listing_filter_matches m set is_current_match = false
    where m.listing_id = any(member_ids);
  end if;
  get diagnostics affected_memberships = row_count;

  return query select p_listing_id, normalized_decision, l.lifecycle_status, affected_memberships
  from public.listings l where l.id = p_listing_id;
end;
$$;

revoke all on function public.apply_confirmed_property_group_review_decision(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_confirmed_property_group_review_decision(uuid, text, text, timestamptz) to service_role;

commit;
