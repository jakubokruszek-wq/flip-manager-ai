begin;
set local lock_timeout = '5s';
alter table public.search_filters add column if not exists year_built_min integer;
alter table public.listings add column if not exists year_built integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.search_filters'::regclass and conname='search_filters_year_built_min_range') then
    alter table public.search_filters add constraint search_filters_year_built_min_range check (year_built_min is null or year_built_min between 1700 and 2100);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.listings'::regclass and conname='listings_year_built_range') then
    alter table public.listings add constraint listings_year_built_range check (year_built is null or year_built between 1700 and 2100);
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
