begin;

-- Read-only counterpart to clear_facebook_watcher_history_atomic(), used by
-- the Watcher's clear-history preflight/preview. It reuses the identical
-- classification expression as the clear function (listing_source <>
-- 'facebook' or cross_source or linked_property or linked_deal) so a preview
-- can never disagree with what an actual clear would do, and it is granted
-- to service_role directly instead of granting service_role broad SELECT on
-- public.properties: SECURITY DEFINER runs this query as the function owner
-- regardless of the caller's own table grants, so no table-level grant
-- change is needed for the preflight to read properties/deals. It performs
-- no INSERT/UPDATE/DELETE and takes no explicit locks beyond the implicit
-- ACCESS SHARE locks any SELECT takes.
create or replace function public.get_facebook_watcher_history_summary()
returns table (
  pure_facebook_listing_ids uuid[],
  preserved_listing_ids uuid[],
  removed_association_listing_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pure_ids uuid[];
  preserved_ids uuid[];
begin
  with candidates as (
    select distinct m.listing_id,
      l.source as listing_source,
      (m.metadata @> '{"crossSourceMatch": true}'::jsonb) as cross_source,
      exists (select 1 from public.properties p where p.listing_id = m.listing_id) as linked_property,
      exists (select 1 from public.deals d where d.listing_id = m.listing_id) as linked_deal
    from public.listing_source_metadata m
    join public.listings l on l.id = m.listing_id
    where m.source = 'facebook'
  ), classified as (
    select listing_id,
      (listing_source <> 'facebook' or cross_source or linked_property or linked_deal) as preserved
    from candidates
  )
  select coalesce(array_agg(listing_id) filter (where not preserved), '{}'), coalesce(array_agg(listing_id) filter (where preserved), '{}')
    into pure_ids, preserved_ids
    from classified;

  return query select coalesce(pure_ids, '{}'), coalesce(preserved_ids, '{}'), coalesce(preserved_ids, '{}');
end;
$$;

revoke all on function public.get_facebook_watcher_history_summary() from public, anon, authenticated;
grant execute on function public.get_facebook_watcher_history_summary() to service_role;

commit;
