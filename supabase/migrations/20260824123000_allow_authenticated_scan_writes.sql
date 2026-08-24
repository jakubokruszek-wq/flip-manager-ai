begin;

-- Allow the authenticated application session to perform only the writes used
-- by the manual scan orchestrator. Existing anon semantics and RLS predicates
-- remain unchanged; DELETE is intentionally not granted.

grant insert, update on table public.source_scans to authenticated;
grant update on table public.search_filters to authenticated;
grant insert, update on table public.listings to authenticated;
grant insert on table public.listing_snapshots to authenticated;
grant insert, update on table public.listing_filter_matches to authenticated;

drop policy if exists "source_scans_insert_development" on public.source_scans;
create policy "source_scans_insert_development"
  on public.source_scans for insert to anon, authenticated with check (true);

drop policy if exists "source_scans_update_development" on public.source_scans;
create policy "source_scans_update_development"
  on public.source_scans for update to anon, authenticated using (true) with check (true);

drop policy if exists "search_filters_update_development" on public.search_filters;
create policy "search_filters_update_development"
  on public.search_filters for update to anon, authenticated using (true) with check (true);

drop policy if exists "listings_insert_development" on public.listings;
create policy "listings_insert_development"
  on public.listings for insert to anon, authenticated with check (true);

drop policy if exists "listings_update_development" on public.listings;
create policy "listings_update_development"
  on public.listings for update to anon, authenticated using (true) with check (true);

drop policy if exists "listing_snapshots_insert_development" on public.listing_snapshots;
create policy "listing_snapshots_insert_development"
  on public.listing_snapshots for insert to anon, authenticated with check (true);

drop policy if exists "listing_filter_matches_insert_development" on public.listing_filter_matches;
create policy "listing_filter_matches_insert_development"
  on public.listing_filter_matches for insert to anon, authenticated with check (true);

drop policy if exists "listing_filter_matches_update_development" on public.listing_filter_matches;
create policy "listing_filter_matches_update_development"
  on public.listing_filter_matches for update to anon, authenticated using (true) with check (true);

commit;
