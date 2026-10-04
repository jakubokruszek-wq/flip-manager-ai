-- Draft only. Apply manually after reviewing the release.
-- Keep scan_interval_minutes unchanged: it is the global Facebook Watcher
-- setting. Finder's automatic new-run cadence is stored separately.

alter table public.search_filters
  add column if not exists finder_scan_interval_minutes integer not null default 60;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.search_filters'::regclass
      and conname = 'search_filters_finder_scan_interval_positive'
  ) then
    alter table public.search_filters
      add constraint search_filters_finder_scan_interval_positive
      check (finder_scan_interval_minutes > 0);
  end if;
end
$$;

create index if not exists search_filters_active_finder_scan_interval_idx
  on public.search_filters (is_active, last_scanned_at, finder_scan_interval_minutes);
