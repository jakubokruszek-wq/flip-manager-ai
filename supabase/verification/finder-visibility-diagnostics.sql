-- READ-ONLY diagnostics for the Finder repair (2026-10-13). No INSERT,
-- UPDATE, DELETE or DDL. Kept outside supabase/migrations on purpose.
-- Run in the Supabase SQL editor; every statement only reads.

-- 1. Filter "Flip" membership profile (expected: 4 current, 87 REVIEW, rest historical).
select count(*) as memberships,
       count(*) filter (where m.is_current_match) as current_matches,
       count(*) filter (where not m.is_current_match and m.match_reasons ? 'review') as review_rows,
       count(*) filter (where not m.is_current_match and not (m.match_reasons ? 'review')) as historical_rows
from public.listing_filter_matches m
join public.search_filters f on f.id = m.search_filter_id
where f.name = 'Flip';

-- 2. The 269 000 zł Śródmieście offer: every fact the Finder read path uses.
with target as (
  select l.*
  from public.listings l
  where l.price = 269000 and l.area between 47.1 and 47.3
)
select t.id, t.source, t.original_url, t.external_listing_id, t.status, t.lifecycle_status, t.manual_decision,
       t.building_type, t.cross_source_identity, t.first_seen_at, t.last_seen_at,
       m.is_current_match, m.match_reasons, m.last_matched_at,
       -- publication dates across snapshots: the Finder shows the EARLIEST one;
       -- a refreshed portal ad has a later "latest" date than the earliest.
       (select min(coalesce(s.raw_data->>'sourcePublishedAt', s.raw_data->'candidate'->>'sourcePublishedAt')) from public.listing_snapshots s where s.listing_id = t.id) as earliest_published,
       (select max(coalesce(s.raw_data->>'sourcePublishedAt', s.raw_data->'candidate'->>'sourcePublishedAt')) from public.listing_snapshots s where s.listing_id = t.id) as latest_published,
       -- building text evidence that the old rule treated as a tenement
       t.description ~* 'kamienic' as description_mentions_tenement,
       substring(t.description from '(?i).{0,60}kamienic.{0,60}') as tenement_context
from target t
left join public.listing_filter_matches m on m.listing_id = t.id
left join public.search_filters f on f.id = m.search_filter_id and f.name = 'Flip';

-- 3. Other listings that deduplication or identity grouping could merge with it
--    (same URL, same external id, or same confirmed cross-portal identity).
with target as (select * from public.listings where price = 269000 and area between 47.1 and 47.3)
select o.id, o.source, o.original_url, o.price, o.lifecycle_status, o.manual_decision, o.building_type, o.last_seen_at,
       m.is_current_match, m.match_reasons
from public.listings o
join target t on o.id <> t.id and (
  o.original_url = t.original_url
  or (o.source = t.source and o.external_listing_id = t.external_listing_id)
  or (o.cross_source_identity is not null and o.cross_source_identity = t.cross_source_identity)
)
left join public.listing_filter_matches m on m.listing_id = o.id
left join public.search_filters f on f.id = m.search_filter_id and f.name = 'Flip';

-- 4. Visible REVIEW offers with an unknown building type (expected 77 on 2026-10-13).
select count(*)
from public.listing_filter_matches m
join public.search_filters f on f.id = m.search_filter_id and f.name = 'Flip'
join public.listings l on l.id = m.listing_id
where not m.is_current_match and m.match_reasons ? 'unknown_buildingType';

-- 5. Why expired Facebook worker nonces accumulate (expected: false until supabase/drafts/retention/02 is applied).
select has_column_privilege('service_role', 'public.facebook_worker_nonces', 'expires_at', 'SELECT') as cleanup_can_filter_by_expiry,
       count(*) filter (where expires_at < now()) as expired_nonces,
       count(*) as total_nonces
from public.facebook_worker_nonces;

-- 6. Index usage check for the new active-view membership read
--    (search_filter_id + is_current_match / match_reasons). The existing
--    listing_filter_matches_filter_current_last_matched_idx covers the
--    filter + is_current_match prefix; at ~4k rows per filter no new index
--    is needed. Re-check if a filter grows past ~50k memberships:
explain (analyze, buffers)
select listing_id, is_current_match, match_reasons
from public.listing_filter_matches
where search_filter_id = (select id from public.search_filters where name = 'Flip' limit 1)
  and (is_current_match or match_reasons @> '["review"]'::jsonb);
