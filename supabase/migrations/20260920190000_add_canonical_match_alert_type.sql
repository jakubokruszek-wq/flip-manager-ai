begin;

-- Adds the canonical_match alert type: fired once per listing when its
-- canonical decision reaches MATCHED (lifecycle_status = 'ACTIVE'), so a
-- MATCHED listing pushes immediately regardless of its opportunity/flip
-- score, distinct from the existing score-threshold alert types. No other
-- column, index, grant, or RLS policy changes; the existing five alert
-- types remain valid.
alter table public.alerts drop constraint if exists alerts_type_check;
alter table public.alerts add constraint alerts_type_check
  check (type in ('facebook_opportunity','high_flip_score','price_drop','private_seller','new_listing','canonical_match'));

commit;
