-- Verification queries for 20261011120000_add_radar_district_queue.sql.
--
-- Deliberately named with a ".verification.sql" suffix, NOT the plain
-- "<timestamp>_name.sql" pattern -- `supabase db push` only ever applies
-- files matching that exact pattern, so this file is never picked up as
-- its own migration step.
--
-- Already run once, successfully, by this mission: wrapped in `begin; ...
-- rollback;` and executed against the real, linked Production database via
-- `supabase db query --linked -f <combined file>` (the 20261011120000
-- migration body followed by this file's DO block, with the trailing
-- `commit;`/leading `begin;` of each stripped to keep it one transaction).
-- All 11 checks (TEST 1 through TEST 7) passed; a follow-up query
-- confirmed `to_regclass('public.price_radar_district_queue')` was NULL
-- afterwards (the table does not exist) and zero leftover
-- price_radar_listings rows remained -- the dry run left no trace.
--
-- To re-run for real confirmation AFTER the migration above has actually
-- been applied: replace test_owner below with a real auth.users id (any
-- existing Radar operator works), then either:
--   a) run this file inside its own `begin; ... rollback;` wrapper again
--      (no permanent effect, safe to repeat any time), or
--   b) run it standalone and inspect the three test rows it leaves in
--      price_radar_district_queue/price_radar_listings
--      (external_listing_id = 'dryrun-ext-1'), then delete them by hand.

drop table if exists pg_temp.dryrun_results;
create temp table dryrun_results (line int generated always as identity, result text);

do $$
declare
  test_owner uuid := '78b0d0b1-766a-4503-96f3-641e8da53d0d'; -- replace with a real operator id
  queue_id uuid;
  saved_listing_id uuid;
  row_count int;
begin
  queue_id := public.upsert_price_radar_district_queue_candidate(test_owner, jsonb_build_object(
    'source', 'domiporta', 'external_listing_id', 'dryrun-ext-1',
    'original_url', 'https://example.test/dryrun-1', 'normalized_url', 'https://example.test/dryrun-1',
    'title', 'Mieszkanie testowe', 'description', 'Opis testowy',
    'price', 450000, 'area', 50, 'price_per_sqm', 9000, 'rooms', 2, 'city', 'Łódź',
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation',
    'content_hash', 'hash-dryrun-1', 'collected_at', now()::text, 'last_seen_at', now()::text
  ));
  select count(*) into row_count from public.price_radar_district_queue where id = queue_id and status = 'pending';
  insert into dryrun_results (result) values (case when queue_id is not null and row_count = 1 then 'TEST 1 PASSED: insert via upsert RPC' else 'TEST 1 FAILED' end);

  perform public.upsert_price_radar_district_queue_candidate(test_owner, jsonb_build_object(
    'source', 'domiporta', 'external_listing_id', 'dryrun-ext-1',
    'original_url', 'https://example.test/dryrun-1', 'normalized_url', 'https://example.test/dryrun-1',
    'title', 'Mieszkanie testowe', 'description', 'Opis testowy zmieniony',
    'price', 460000, 'area', 50, 'price_per_sqm', 9200, 'rooms', 2, 'city', 'Łódź',
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation',
    'content_hash', 'hash-dryrun-1b', 'collected_at', now()::text, 'last_seen_at', now()::text
  ));
  select count(*) into row_count from public.price_radar_district_queue where owner_id = test_owner and source = 'domiporta' and external_listing_id = 'dryrun-ext-1';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 2a PASSED: no duplicate row on reimport' else 'TEST 2a FAILED: ' || row_count::text || ' rows' end);
  select count(*) into row_count from public.price_radar_district_queue where id = queue_id and price = 460000 and status = 'pending';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 2b PASSED: snapshot refreshed, status preserved' else 'TEST 2b FAILED' end);

  perform public.set_price_radar_district_queue_rejection(test_owner, queue_id, true);
  select count(*) into row_count from public.price_radar_district_queue where id = queue_id and status = 'rejected' and rejected_at is not null;
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 3a PASSED: reject sets status/rejected_at' else 'TEST 3a FAILED' end);
  perform public.set_price_radar_district_queue_rejection(test_owner, queue_id, false);
  select count(*) into row_count from public.price_radar_district_queue where id = queue_id and status = 'pending' and rejected_at is null;
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 3b PASSED: undo-reject restores pending' else 'TEST 3b FAILED' end);

  perform public.set_price_radar_district_queue_rejection(test_owner, queue_id, true);
  perform public.upsert_price_radar_district_queue_candidate(test_owner, jsonb_build_object(
    'source', 'domiporta', 'external_listing_id', 'dryrun-ext-1',
    'original_url', 'https://example.test/dryrun-1', 'normalized_url', 'https://example.test/dryrun-1',
    'title', 'Mieszkanie testowe', 'description', 'Opis po kolejnym skanie',
    'price', 470000, 'area', 50, 'price_per_sqm', 9400, 'rooms', 2, 'city', 'Łódź',
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation',
    'content_hash', 'hash-dryrun-1c', 'collected_at', now()::text, 'last_seen_at', now()::text
  ));
  select count(*) into row_count from public.price_radar_district_queue where id = queue_id and status = 'rejected' and price = 470000;
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 4 PASSED: rescan preserves rejection while refreshing data' else 'TEST 4 FAILED' end);
  perform public.set_price_radar_district_queue_rejection(test_owner, queue_id, false);

  saved_listing_id := public.assign_price_radar_district_queue_candidate(test_owner, queue_id, 'Bałuty', test_owner, jsonb_build_object(
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation', 'price_per_sqm', 9400
  ));
  select count(*) into row_count from public.price_radar_listings where id = saved_listing_id and district = 'Bałuty' and owner_id = test_owner;
  insert into dryrun_results (result) values (case when saved_listing_id is not null and row_count = 1 then 'TEST 5a PASSED: assign promotes into price_radar_listings' else 'TEST 5a FAILED' end);
  select count(*) into row_count from public.price_radar_district_queue where id = queue_id and status = 'assigned' and assigned_district = 'Bałuty' and radar_listing_id = saved_listing_id;
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 5b PASSED: queue row marked assigned with linked listing id' else 'TEST 5b FAILED' end);

  perform public.assign_price_radar_district_queue_candidate(test_owner, queue_id, 'Górna', test_owner, jsonb_build_object(
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation', 'price_per_sqm', 9400
  ));
  select count(*) into row_count from public.price_radar_listings where owner_id = test_owner and source = 'domiporta' and external_listing_id = 'dryrun-ext-1';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 6a PASSED: correction does not duplicate the listing row' else 'TEST 6a FAILED: ' || row_count::text || ' rows' end);
  select count(*) into row_count from public.price_radar_listings where id = saved_listing_id and district = 'Górna';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 6b PASSED: correction updates the district on the same row' else 'TEST 6b FAILED' end);

  begin
    perform public.assign_price_radar_district_queue_candidate(test_owner, queue_id, 'Nieznana', test_owner, '{}'::jsonb);
    insert into dryrun_results (result) values ('TEST 7 FAILED: invalid district was not rejected');
  exception when others then
    insert into dryrun_results (result) values (case when sqlerrm = 'INVALID_DISTRICT' then 'TEST 7 PASSED: invalid district name rejected' else 'TEST 7 FAILED: wrong error ' || sqlerrm end);
  end;

  -- TEST 8: suggestion_* columns (added alongside the AI/GIS district
  -- recognition work) round-trip through the same upsert RPC on a
  -- separate row, including the app-level "pass the prior suggestion back
  -- unchanged" cache-reuse pattern upsertPendingDistrictCandidate uses.
  perform public.upsert_price_radar_district_queue_candidate(test_owner, jsonb_build_object(
    'source', 'domiporta', 'external_listing_id', 'dryrun-ext-2',
    'original_url', 'https://example.test/dryrun-2', 'normalized_url', 'https://example.test/dryrun-2',
    'title', 'Mieszkanie testowe 2', 'description', 'Opis testowy 2',
    'price', 350000, 'area', 40, 'price_per_sqm', 8750, 'rooms', 1, 'city', 'Łódź',
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation',
    'content_hash', 'hash-dryrun-2a', 'collected_at', now()::text, 'last_seen_at', now()::text,
    'suggested_district', 'Górna', 'suggestion_source', 'gis', 'suggestion_evidence', 'Piastów-Kurak'
  ));
  select count(*) into row_count from public.price_radar_district_queue
   where owner_id = test_owner and source = 'domiporta' and external_listing_id = 'dryrun-ext-2'
     and suggested_district = 'Górna' and suggestion_source = 'gis' and suggestion_evidence = 'Piastów-Kurak';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 8a PASSED: suggestion fields stored on insert' else 'TEST 8a FAILED' end);

  -- Same content_hash as above: the app layer would skip GIS/AI and pass
  -- the SAME suggestion back unchanged -- the RPC just stores whatever it
  -- is given, so this confirms that no-op round-trip leaves it intact.
  perform public.upsert_price_radar_district_queue_candidate(test_owner, jsonb_build_object(
    'source', 'domiporta', 'external_listing_id', 'dryrun-ext-2',
    'original_url', 'https://example.test/dryrun-2', 'normalized_url', 'https://example.test/dryrun-2',
    'title', 'Mieszkanie testowe 2', 'description', 'Opis testowy 2',
    'price', 350000, 'area', 40, 'price_per_sqm', 8750, 'rooms', 1, 'city', 'Łódź',
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation',
    'content_hash', 'hash-dryrun-2a', 'collected_at', now()::text, 'last_seen_at', now()::text,
    'suggested_district', 'Górna', 'suggestion_source', 'gis', 'suggestion_evidence', 'Piastów-Kurak'
  ));
  select count(*) into row_count from public.price_radar_district_queue
   where owner_id = test_owner and source = 'domiporta' and external_listing_id = 'dryrun-ext-2' and suggested_district = 'Górna';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 8b PASSED: unchanged-content cache reuse round-trips' else 'TEST 8b FAILED' end);

  -- Content actually changed: the app layer would recompute and pass a
  -- genuinely different suggestion.
  perform public.upsert_price_radar_district_queue_candidate(test_owner, jsonb_build_object(
    'source', 'domiporta', 'external_listing_id', 'dryrun-ext-2',
    'original_url', 'https://example.test/dryrun-2', 'normalized_url', 'https://example.test/dryrun-2',
    'title', 'Mieszkanie testowe 2', 'description', 'Opis zmieniony, blisko Manufaktury',
    'price', 355000, 'area', 40, 'price_per_sqm', 8875, 'rooms', 1, 'city', 'Łódź',
    'building_type', 'blok', 'market_type', 'secondary', 'renovation_status', 'fresh_renovation',
    'content_hash', 'hash-dryrun-2b', 'collected_at', now()::text, 'last_seen_at', now()::text,
    'suggested_district', 'Śródmieście', 'suggestion_source', 'ai', 'suggestion_evidence', 'blisko Manufaktury'
  ));
  select count(*) into row_count from public.price_radar_district_queue
   where owner_id = test_owner and source = 'domiporta' and external_listing_id = 'dryrun-ext-2'
     and suggested_district = 'Śródmieście' and suggestion_source = 'ai' and suggestion_evidence = 'blisko Manufaktury';
  insert into dryrun_results (result) values (case when row_count = 1 then 'TEST 8c PASSED: changed-content reimport overwrites the suggestion' else 'TEST 8c FAILED' end);
end $$;

select result from dryrun_results order by line;
