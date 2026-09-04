begin;

-- Visibility lifecycle is additive and keeps the existing listing history intact.
alter table public.listings
  add column if not exists review_reason text,
  add column if not exists missing_fields jsonb,
  add column if not exists manual_decision text,
  add column if not exists manual_decision_reason text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists lifecycle_status text,
  add column if not exists archived_at timestamptz;

alter table public.listings
  alter column missing_fields set default '[]'::jsonb,
  alter column lifecycle_status set default 'ACTIVE';

update public.listings
set missing_fields = '[]'::jsonb
where missing_fields is null;

-- Use only timestamps already present in the record. Rows without a reliable
-- observation timestamp are kept in history but hidden from the active finder.
update public.listings
set last_seen_at = coalesce(last_seen_at, updated_at, created_at),
    lifecycle_status = case
      when status <> 'active' then 'ARCHIVED'
      when coalesce(last_seen_at, updated_at, created_at) is null then 'ARCHIVED'
      when coalesce(last_seen_at, updated_at, created_at) < now() - interval '14 days' then 'ARCHIVED'
      when coalesce(last_seen_at, updated_at, created_at) < now() - interval '7 days' then 'STALE'
      else case when lifecycle_status = 'REVIEW' then 'REVIEW' else 'ACTIVE' end
    end
where manual_decision is distinct from 'REJECTED'
  and (lifecycle_status is null or lifecycle_status in ('ACTIVE', 'REVIEW', 'STALE'));

update public.listings
set lifecycle_status = 'REJECTED'
where manual_decision = 'REJECTED' and lifecycle_status <> 'REJECTED';

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.listings'::regclass and conname = 'listings_lifecycle_status_check') then
    alter table public.listings add constraint listings_lifecycle_status_check
      check (lifecycle_status in ('ACTIVE', 'REVIEW', 'STALE', 'ARCHIVED', 'REJECTED'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.listings'::regclass and conname = 'listings_manual_decision_check') then
    alter table public.listings add constraint listings_manual_decision_check
      check (manual_decision is null or manual_decision in ('ACCEPTED', 'REJECTED'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.listings'::regclass and conname = 'listings_missing_fields_array_check') then
    alter table public.listings add constraint listings_missing_fields_array_check
      check (jsonb_typeof(missing_fields) = 'array');
  end if;
end $$;

create index if not exists listings_lifecycle_status_last_seen_idx
  on public.listings (lifecycle_status, last_seen_at desc);

create or replace function public.cleanup_listing_visibility_lifecycle(p_now timestamptz default now())
returns table(stale_count bigint, archived_count bigint)
language plpgsql
security invoker
as $$
begin
  update public.listings
  set lifecycle_status = 'REJECTED'
  where manual_decision = 'REJECTED'
    and lifecycle_status <> 'REJECTED';

  update public.listings
  set lifecycle_status = 'ARCHIVED', archived_at = coalesce(archived_at, p_now)
  where lifecycle_status in ('ACTIVE', 'REVIEW', 'STALE')
    and manual_decision is distinct from 'REJECTED'
    and last_seen_at is not null
    and last_seen_at < p_now - interval '14 days';
  get diagnostics archived_count = row_count;

  update public.listings
  set lifecycle_status = 'STALE'
  where lifecycle_status in ('ACTIVE', 'REVIEW')
    and manual_decision is distinct from 'REJECTED'
    and last_seen_at is not null
    and last_seen_at < p_now - interval '7 days'
    and last_seen_at >= p_now - interval '14 days';
  get diagnostics stale_count = row_count;

  return next;
end;
$$;

commit;
