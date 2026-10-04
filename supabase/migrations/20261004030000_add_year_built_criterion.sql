begin;

-- DRAFT -- not applied by this change. Adds the "Rok budowy od" (year built
-- from) Finder filter criterion: search_filters.year_built_min is the
-- user-set minimum, listings.year_built is the construction year read from
-- an explicit source label (e.g. Allegro Lokalnie's "Rok budowy: 1897" --
-- see features/flip-finder/external-source-adapters.ts's
-- allegroLokalnieYearBuiltByPath). Application code (search-filters.ts's
-- writeSearchFilter/toSearchFilter, persist-listing.ts) only ever assumes
-- these columns exist after first probing for the exact "column does not
-- exist" error and falling back to the pre-existing shape otherwise, so
-- today's deploys are unaffected either way until a human applies this.

alter table public.search_filters
  add column if not exists year_built_min integer;

alter table public.search_filters
  drop constraint if exists search_filters_year_built_min_range;

alter table public.search_filters
  add constraint search_filters_year_built_min_range
  check (year_built_min is null or (year_built_min >= 1700 and year_built_min <= 2100));

alter table public.listings
  add column if not exists year_built integer;

alter table public.listings
  drop constraint if exists listings_year_built_range;

alter table public.listings
  add constraint listings_year_built_range
  check (year_built is null or (year_built >= 1700 and year_built <= 2100));

commit;
