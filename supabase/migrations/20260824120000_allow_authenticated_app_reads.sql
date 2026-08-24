begin;

-- The application now authenticates browser/server requests with Supabase Auth.
-- Preserve the existing development-wide SELECT semantics while allowing the
-- authenticated role to read the same application data. Write permissions and
-- all existing policies remain unchanged.

grant select on table public.properties to authenticated;
grant select on table public.listings to authenticated;
grant select on table public.listing_snapshots to authenticated;
grant select on table public.search_filters to authenticated;
grant select on table public.source_scans to authenticated;
grant select on table public.listing_filter_matches to authenticated;

drop policy if exists "properties_select_development" on public.properties;
create policy "properties_select_development"
  on public.properties for select to anon, authenticated using (true);

drop policy if exists "listings_select_development" on public.listings;
create policy "listings_select_development"
  on public.listings for select to anon, authenticated using (true);

drop policy if exists "listing_snapshots_select_development" on public.listing_snapshots;
create policy "listing_snapshots_select_development"
  on public.listing_snapshots for select to anon, authenticated using (true);

drop policy if exists "search_filters_select_development" on public.search_filters;
create policy "search_filters_select_development"
  on public.search_filters for select to anon, authenticated using (true);

drop policy if exists "source_scans_select_development" on public.source_scans;
create policy "source_scans_select_development"
  on public.source_scans for select to anon, authenticated using (true);

drop policy if exists "listing_filter_matches_select_development" on public.listing_filter_matches;
create policy "listing_filter_matches_select_development"
  on public.listing_filter_matches for select to anon, authenticated using (true);

commit;
