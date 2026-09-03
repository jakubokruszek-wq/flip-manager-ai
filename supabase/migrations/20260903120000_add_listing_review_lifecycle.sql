begin;

alter table public.listings
  add column if not exists review_reason text,
  add column if not exists missing_fields jsonb not null default '[]'::jsonb,
  add column if not exists manual_decision text,
  add column if not exists manual_decision_reason text,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists lifecycle_status text not null default 'ACTIVE',
  add column if not exists archived_at timestamptz;

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

update public.listings
set lifecycle_status = case
  when status <> 'active' then 'ARCHIVED'
  when last_seen_at < now() - interval '14 days' then 'ARCHIVED'
  when last_seen_at < now() - interval '7 days' then 'STALE'
  else 'ACTIVE'
end
where lifecycle_status = 'ACTIVE';

create index if not exists listings_lifecycle_status_last_seen_idx
  on public.listings (lifecycle_status, last_seen_at desc);

commit;
