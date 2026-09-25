begin;

-- Human mutations now pass through authenticated server routes. Preserve the
-- existing read policies, while removing direct browser writes to the tables
-- those routes mutate.
alter table public.listings enable row level security;
alter table public.search_filters enable row level security;
alter table public.listing_filter_matches enable row level security;
alter table public.properties enable row level security;

revoke insert, update, delete on table public.listings from public, anon, authenticated;
revoke insert, update, delete on table public.search_filters from public, anon, authenticated;
revoke insert, update, delete on table public.listing_filter_matches from public, anon, authenticated;
revoke insert, update, delete on table public.properties from public, anon, authenticated;

grant insert, update, delete on table public.listings to service_role;
grant insert, update, delete on table public.search_filters to service_role;
grant insert, update, delete on table public.listing_filter_matches to service_role;
grant insert, update, delete on table public.properties to service_role;

drop policy if exists "listings_insert_development" on public.listings;
drop policy if exists "listings_update_development" on public.listings;
drop policy if exists "listings_delete_development" on public.listings;

drop policy if exists "search_filters_insert_development" on public.search_filters;
drop policy if exists "search_filters_update_development" on public.search_filters;
drop policy if exists "search_filters_delete_development" on public.search_filters;

drop policy if exists "listing_filter_matches_insert_development" on public.listing_filter_matches;
drop policy if exists "listing_filter_matches_update_development" on public.listing_filter_matches;
drop policy if exists "listing_filter_matches_delete_development" on public.listing_filter_matches;

drop policy if exists "properties_insert_development" on public.properties;
drop policy if exists "properties_update_development" on public.properties;
drop policy if exists "properties_delete_development" on public.properties;

create or replace function public.apply_listing_review_decision(
  p_listing_id uuid,
  p_decision text,
  p_reason text default null,
  p_now timestamptz default now()
)
returns table(
  listing_id uuid,
  decision text,
  lifecycle_status text,
  membership_count bigint
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  target public.listings%rowtype;
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

  select l.*
  into target
  from public.listings as l
  where l.id = p_listing_id
  for update;

  if not found then
    raise exception 'LISTING_REVIEW_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not (
    (target.lifecycle_status = 'REVIEW' and target.manual_decision is null)
    or (normalized_decision = 'ACCEPTED' and target.lifecycle_status = 'ACTIVE' and target.manual_decision = 'ACCEPTED')
    or (normalized_decision = 'REJECTED' and target.lifecycle_status = 'REJECTED' and target.manual_decision = 'REJECTED')
  ) then
    raise exception 'LISTING_REVIEW_INVALID_TRANSITION:%:%', coalesce(target.lifecycle_status, 'NULL'), coalesce(target.manual_decision, 'NULL')
      using errcode = 'P0001';
  end if;

  if normalized_decision = 'ACCEPTED' then
    update public.listings as l
    set lifecycle_status = 'ACTIVE',
        manual_decision = 'ACCEPTED',
        manual_decision_reason = normalized_reason,
        review_reason = null,
        missing_fields = '[]'::jsonb,
        archived_at = null,
        status = 'active'
    where l.id = p_listing_id;

    update public.listing_filter_matches as membership
    set is_current_match = true,
        last_matched_at = p_now,
        match_reasons = jsonb_build_array('manual_accept') || coalesce((
          select jsonb_agg(reason.value order by reason.position)
          from jsonb_array_elements_text(coalesce(membership.match_reasons, '[]'::jsonb))
            with ordinality as reason(value, position)
          where reason.value <> 'manual_accept'
            and reason.value <> 'review'
            and reason.value not like 'unknown\_%' escape '\'
        ), '[]'::jsonb)
    where membership.listing_id = p_listing_id;
  else
    update public.listings as l
    set lifecycle_status = 'REJECTED',
        manual_decision = 'REJECTED',
        manual_decision_reason = normalized_reason,
        review_reason = null,
        missing_fields = '[]'::jsonb,
        archived_at = coalesce(l.archived_at, p_now)
    where l.id = p_listing_id;

    update public.listing_filter_matches as membership
    set is_current_match = false
    where membership.listing_id = p_listing_id;
  end if;

  get diagnostics affected_memberships = row_count;
  if affected_memberships = 0 then
    raise exception 'LISTING_REVIEW_MEMBERSHIP_MISSING' using errcode = 'P0001';
  end if;

  return query
  select p_listing_id, normalized_decision, l.lifecycle_status, affected_memberships
  from public.listings as l
  where l.id = p_listing_id;
end;
$$;

revoke all on function public.apply_listing_review_decision(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_listing_review_decision(uuid, text, text, timestamptz) to service_role;

commit;
