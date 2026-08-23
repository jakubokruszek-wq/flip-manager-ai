begin;

alter table public.listings
  add column if not exists availability_miss_count integer not null default 0,
  add column if not exists availability_last_checked_at timestamptz,
  add column if not exists availability_next_check_at timestamptz,
  add column if not exists availability_last_result text,
  add column if not exists availability_last_http_status integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.listings'::regclass
      and conname = 'listings_availability_miss_count_nonnegative'
  ) then
    alter table public.listings add constraint listings_availability_miss_count_nonnegative
      check (availability_miss_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.listings'::regclass
      and conname = 'listings_availability_last_result_check'
  ) then
    alter table public.listings add constraint listings_availability_last_result_check
      check (availability_last_result is null or availability_last_result in (
        'available', 'explicit_removed', 'ambiguous_missing', 'temporary_failure'
      ));
  end if;
end $$;

create index if not exists listings_availability_revalidation_idx
  on public.listings (status, availability_next_check_at nulls first, last_seen_at)
  where status = 'active';

commit;
