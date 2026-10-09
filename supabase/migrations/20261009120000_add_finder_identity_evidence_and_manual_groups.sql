begin;

alter table public.listings
  add column if not exists identity_evidence jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'listings_identity_evidence_object_check'
      and conrelid = 'public.listings'::regclass
  ) then
    alter table public.listings
      add constraint listings_identity_evidence_object_check
      check (identity_evidence is null or jsonb_typeof(identity_evidence) = 'object');
  end if;
end;
$$;

create table if not exists public.finder_listing_identity_groups (
  owner_id uuid not null,
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  group_id uuid not null,
  listing_id uuid not null references public.listings(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, search_filter_id, listing_id)
);

create index if not exists finder_listing_identity_groups_lookup_idx
  on public.finder_listing_identity_groups (owner_id, search_filter_id, group_id, listing_id);

create table if not exists public.finder_listing_identity_decisions (
  owner_id uuid not null,
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  listing_a uuid not null references public.listings(id) on delete cascade,
  listing_b uuid not null references public.listings(id) on delete cascade,
  decision text not null check (decision in ('link', 'not_link')),
  created_at timestamptz not null default now(),
  primary key (owner_id, search_filter_id, listing_a, listing_b),
  check (listing_a < listing_b)
);

alter table public.finder_listing_identity_groups enable row level security;
alter table public.finder_listing_identity_decisions enable row level security;
revoke all on public.finder_listing_identity_groups, public.finder_listing_identity_decisions from public, anon, authenticated;
grant all on public.finder_listing_identity_groups, public.finder_listing_identity_decisions to service_role;
grant select on public.finder_listing_identity_groups, public.finder_listing_identity_decisions to authenticated;

drop policy if exists finder_listing_identity_groups_read_own on public.finder_listing_identity_groups;
create policy finder_listing_identity_groups_read_own
  on public.finder_listing_identity_groups
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists finder_listing_identity_decisions_read_own on public.finder_listing_identity_decisions;
create policy finder_listing_identity_decisions_read_own
  on public.finder_listing_identity_decisions
  for select to authenticated
  using (owner_id = (select auth.uid()));

create or replace function public.manage_finder_listing_identity(
  p_owner_id uuid,
  p_search_filter_id uuid,
  p_action text,
  p_listing_a uuid,
  p_listing_b uuid default null
)
returns table(action text, group_id uuid, affected_listing_ids uuid[])
language plpgsql
security invoker
set search_path = public
as $$
declare
  normalized_action text := lower(trim(coalesce(p_action, '')));
  existing_group_ids uuid[];
  target_group uuid;
  members uuid[];
  removed_members uuid[];
  left_evidence jsonb;
  right_evidence jsonb;
  member_id uuid;
  pair_row record;
begin
  if p_owner_id is null or p_search_filter_id is null or p_listing_a is null then
    raise exception 'FINDER_IDENTITY_INVALID_ARGUMENT' using errcode = '22023';
  end if;
  if normalized_action not in ('link', 'not_link', 'unlink') then
    raise exception 'FINDER_IDENTITY_INVALID_ACTION' using errcode = '22023';
  end if;
  if not exists (select 1 from public.search_filters f where f.id = p_search_filter_id) then
    raise exception 'FINDER_IDENTITY_FILTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner_id::text || ':' || p_search_filter_id::text, 0));
  if not exists (select 1 from public.listing_filter_matches m where m.search_filter_id = p_search_filter_id and m.listing_id = p_listing_a) then
    raise exception 'FINDER_IDENTITY_LISTING_OUTSIDE_FILTER' using errcode = '42501';
  end if;

  if normalized_action = 'unlink' then
    select g.group_id into target_group from public.finder_listing_identity_groups g
      where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.listing_id = p_listing_a
      for update;
    if not found then raise exception 'FINDER_IDENTITY_GROUP_NOT_FOUND' using errcode = 'P0002'; end if;
    select array_agg(g.listing_id order by g.listing_id) into members
      from public.finder_listing_identity_groups g
      where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = target_group;
    removed_members := array_remove(members, p_listing_a);
    if coalesce(cardinality(removed_members), 0) = 0 then
      delete from public.finder_listing_identity_groups g where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = target_group;
      return query select normalized_action, null::uuid, array[p_listing_a]::uuid[];
      return;
    end if;
    delete from public.finder_listing_identity_groups g where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.listing_id = p_listing_a;
    if cardinality(removed_members) = 1 then
      delete from public.finder_listing_identity_groups g where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = target_group;
    end if;
    foreach member_id in array removed_members loop
      insert into public.finder_listing_identity_decisions(owner_id, search_filter_id, listing_a, listing_b, decision)
      values (p_owner_id, p_search_filter_id, least(p_listing_a, member_id), greatest(p_listing_a, member_id), 'not_link')
      on conflict (owner_id, search_filter_id, listing_a, listing_b) do update set decision = 'not_link', created_at = now();
    end loop;
    return query select normalized_action, null::uuid, array[p_listing_a]::uuid[];
    return;
  end if;

  if p_listing_b is null or p_listing_a = p_listing_b then
    raise exception 'FINDER_IDENTITY_PAIR_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.listing_filter_matches m where m.search_filter_id = p_search_filter_id and m.listing_id = p_listing_b) then
    raise exception 'FINDER_IDENTITY_LISTING_OUTSIDE_FILTER' using errcode = '42501';
  end if;

  if normalized_action = 'not_link' then
    insert into public.finder_listing_identity_decisions(owner_id, search_filter_id, listing_a, listing_b, decision)
    values (p_owner_id, p_search_filter_id, least(p_listing_a, p_listing_b), greatest(p_listing_a, p_listing_b), 'not_link')
    on conflict (owner_id, search_filter_id, listing_a, listing_b) do update set decision = 'not_link', created_at = now();
    return query select normalized_action, null::uuid, array[least(p_listing_a,p_listing_b), greatest(p_listing_a,p_listing_b)]::uuid[];
    return;
  end if;

  -- Lock the filter's membership rows in deterministic order. The transaction
  -- serializes manual group edits for this filter without changing listings,
  -- match history, CRM rows, or Radar exclusions.
  perform 1 from public.listing_filter_matches m
    where m.search_filter_id = p_search_filter_id and m.listing_id in (p_listing_a, p_listing_b)
    order by m.listing_id for update;
  if exists (
    select 1 from public.listings l where l.id in (p_listing_a, p_listing_b)
      and (l.lifecycle_status = 'REJECTED' or l.manual_decision = 'REJECTED')
  ) then raise exception 'FINDER_IDENTITY_REJECTED_LISTING' using errcode = 'P0001'; end if;

  select array_agg(distinct g.group_id order by g.group_id) into existing_group_ids
    from public.finder_listing_identity_groups g
    where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.listing_id in (p_listing_a, p_listing_b);
  select array_agg(distinct ids.listing_id order by ids.listing_id) into members
    from (
      select p_listing_a as listing_id union select p_listing_b
      union select g.listing_id from public.finder_listing_identity_groups g
        where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = any(coalesce(existing_group_ids, array[]::uuid[]))
    ) ids;

  -- Manual confirmation can resolve missing evidence, but it cannot override
  -- explicit contradictory unit/building/market facts. Check every pair in
  -- the resulting group, not only the two buttons clicked by the operator.
  for pair_row in
    select l1.identity_evidence as left_evidence, l2.identity_evidence as right_evidence
    from public.listings l1 join public.listings l2 on l1.id < l2.id
    where l1.id = any(members) and l2.id = any(members)
  loop
    left_evidence := coalesce(pair_row.left_evidence, '{}'::jsonb);
    right_evidence := coalesce(pair_row.right_evidence, '{}'::jsonb);
    if (left_evidence->>'marketType' is not null and right_evidence->>'marketType' is not null and left_evidence->>'marketType' <> right_evidence->>'marketType')
      or (left_evidence->>'buildingType' is not null and right_evidence->>'buildingType' is not null and left_evidence->>'buildingType' <> right_evidence->>'buildingType')
      or (left_evidence->>'buildingKey' is not null and right_evidence->>'buildingKey' is not null and left_evidence->>'buildingKey' <> right_evidence->>'buildingKey')
      or (left_evidence->>'apartmentNumber' is not null and right_evidence->>'apartmentNumber' is not null and left_evidence->>'buildingKey' = right_evidence->>'buildingKey' and left_evidence->>'apartmentNumber' <> right_evidence->>'apartmentNumber')
      or (left_evidence#>>'{agencyReference,agency}' is not null and right_evidence#>>'{agencyReference,agency}' is not null and left_evidence#>>'{agencyReference,agency}' = right_evidence#>>'{agencyReference,agency}' and left_evidence#>>'{agencyReference,number}' <> right_evidence#>>'{agencyReference,number}')
      or (left_evidence->>'rooms' is not null and right_evidence->>'rooms' is not null and left_evidence->>'rooms' <> right_evidence->>'rooms')
      or (left_evidence->>'floor' is not null and right_evidence->>'floor' is not null and left_evidence->>'floor' <> right_evidence->>'floor')
      or (left_evidence->>'area' is not null and right_evidence->>'area' is not null and abs((left_evidence->>'area')::numeric - (right_evidence->>'area')::numeric) > greatest(0.3, least(0.8, greatest((left_evidence->>'area')::numeric, (right_evidence->>'area')::numeric) * 0.012)))
    then raise exception 'FINDER_IDENTITY_CONTRADICTORY_EVIDENCE' using errcode = '22023'; end if;
  end loop;

  target_group := coalesce(existing_group_ids[1], gen_random_uuid());
  if coalesce(cardinality(existing_group_ids), 0) > 0 then
    update public.finder_listing_identity_groups g set group_id = target_group
      where g.owner_id = p_owner_id and g.search_filter_id = p_search_filter_id and g.group_id = any(existing_group_ids);
  end if;
  insert into public.finder_listing_identity_groups(owner_id, search_filter_id, group_id, listing_id)
    select p_owner_id, p_search_filter_id, target_group, ids.listing_id from unnest(members) ids(listing_id)
    on conflict (owner_id, search_filter_id, listing_id) do update set group_id = excluded.group_id;
  insert into public.finder_listing_identity_decisions(owner_id, search_filter_id, listing_a, listing_b, decision)
    values (p_owner_id, p_search_filter_id, least(p_listing_a, p_listing_b), greatest(p_listing_a, p_listing_b), 'link')
    on conflict (owner_id, search_filter_id, listing_a, listing_b) do update set decision = 'link', created_at = now();
  return query select normalized_action, target_group, members;
end;
$$;

revoke all on function public.manage_finder_listing_identity(uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.manage_finder_listing_identity(uuid, uuid, text, uuid, uuid) to service_role;

commit;
