begin;

-- reconcile_canonical_listing_decision's RETURNS TABLE clause implicitly
-- declares plpgsql OUT variables named listing_id and search_filter_id
-- (matching the output column names). The ON CONFLICT (listing_id,
-- search_filter_id) target list further down is a bare, unqualified
-- column-name list, and plpgsql's post-parse column-reference resolution
-- treats it as a general reference site: since both names ALSO match
-- columns of public.listing_filter_matches (the INSERT's target table),
-- Postgres raises 42702 "column reference is ambiguous" on every call,
-- deterministically. This is CONFIRMED by locally reproducing the exact
-- 42702 (code, message, and internal statement/position) against the
-- unmodified function body using a real embedded Postgres engine — not
-- inferred from source reading alone.
--
-- Postgres's ON CONFLICT (...) column-list grammar only accepts bare
-- column names — neither `table.column` nor `alias.column` qualification
-- is accepted there (both were tried against the same local reproduction
-- and both are plain syntax errors, confirmed empirically), so the usual
-- "qualify with an alias" fix is not applicable to this exact clause.
-- ON CONFLICT ON CONSTRAINT <name> instead targets the conflict by the
-- constraint's own identity rather than by a column-name list, which
-- removes the ambiguous bare references entirely while resolving the
-- exact same conflict (public.listing_filter_matches's primary key is
-- declared inline as `primary key (listing_id, search_filter_id)` in
-- 20260719113000_create_flip_finder_foundation.sql, so Postgres's default
-- naming assigns it listing_filter_matches_pkey). Verified locally,
-- before and after, that this produces byte-identical results across
-- MATCHED/REVIEW/REJECTED, is idempotent on retry with no duplicate rows,
-- and correctly maintains independent membership rows per filter for the
-- same listing. No other identifier in this function is ambiguous: every
-- other RETURNS TABLE output name (bucket, is_current_match, match_reasons)
-- is only ever referenced as an INSERT column-list entry (also unaffected
-- by plpgsql variable shadowing), an UPDATE SET target (resolved against
-- the target table by SQL grammar, never a general expression), or
-- explicitly qualified via `excluded.`.
create or replace function public.reconcile_canonical_listing_decision(
  p_listing_id uuid,
  p_filter_id uuid,
  p_bucket text,
  p_reasons jsonb,
  p_missing_fields jsonb,
  p_lifecycle_status text,
  p_match_origin text default 'scan',
  p_source_scan_id uuid default null,
  p_matched_at timestamptz default now()
)
returns table (
  listing_id uuid,
  search_filter_id uuid,
  bucket text,
  lifecycle_status text,
  is_current_match boolean,
  match_reasons jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.listings%rowtype;
  normalized_reasons jsonb;
  normalized_missing jsonb;
  current_match boolean;
  next_lifecycle text;
begin
  if p_bucket not in ('MATCHED', 'REVIEW', 'REJECTED') then
    raise exception 'CANONICAL_BUCKET_INVALID';
  end if;
  if p_match_origin not in ('scan', 'filter_recalculation', 'collector_import') then
    raise exception 'CANONICAL_MATCH_ORIGIN_INVALID';
  end if;
  if jsonb_typeof(coalesce(p_reasons, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_missing_fields, '[]'::jsonb)) <> 'array' then
    raise exception 'CANONICAL_REASONS_INVALID';
  end if;

  select * into target
    from public.listings
   where id = p_listing_id
   for update;
  if target.id is null then
    raise exception 'CANONICAL_LISTING_NOT_FOUND';
  end if;
  if not exists (select 1 from public.search_filters where id = p_filter_id) then
    raise exception 'CANONICAL_FILTER_NOT_FOUND';
  end if;

  normalized_reasons := coalesce(p_reasons, '[]'::jsonb);
  normalized_missing := coalesce(p_missing_fields, '[]'::jsonb);
  current_match := p_bucket = 'MATCHED';
  next_lifecycle := case when p_bucket = 'MATCHED' then 'ACTIVE' else p_lifecycle_status end;
  if next_lifecycle not in ('ACTIVE', 'REVIEW', 'REJECTED', 'STALE', 'ARCHIVED') then
    raise exception 'CANONICAL_LIFECYCLE_INVALID';
  end if;

  if p_bucket = 'REVIEW' and not (normalized_reasons ? 'review') then
    normalized_reasons := jsonb_build_array('review') || normalized_reasons;
  end if;
  if p_bucket = 'REVIEW' then
    normalized_reasons := normalized_reasons || coalesce(
      (select jsonb_agg('unknown_' || value)
         from jsonb_array_elements_text(normalized_missing) as fields(value)
        where not (normalized_reasons ? ('unknown_' || value))),
      '[]'::jsonb
    );
  end if;

  update public.listings
     set lifecycle_status = next_lifecycle,
         archived_at = case when p_bucket in ('MATCHED', 'REVIEW') then null else archived_at end,
         review_reason = case when p_bucket = 'REVIEW' then array_to_string(array(select jsonb_array_elements_text(normalized_reasons)), ', ') else null end,
         missing_fields = case when p_bucket = 'REVIEW' then normalized_missing else '[]'::jsonb end,
         status = 'active'
   where id = p_listing_id;

  insert into public.listing_filter_matches (
    listing_id, search_filter_id, last_matched_at, is_current_match,
    match_reasons, match_origin, source_scan_id
  ) values (
    p_listing_id, p_filter_id, coalesce(p_matched_at, now()), current_match,
    normalized_reasons, p_match_origin, p_source_scan_id
  )
  on conflict on constraint listing_filter_matches_pkey do update set
    last_matched_at = excluded.last_matched_at,
    is_current_match = excluded.is_current_match,
    match_reasons = excluded.match_reasons,
    match_origin = excluded.match_origin,
    source_scan_id = excluded.source_scan_id;

  return query select p_listing_id, p_filter_id, p_bucket, next_lifecycle, current_match, normalized_reasons;
end;
$$;

revoke all on function public.reconcile_canonical_listing_decision(uuid, uuid, text, jsonb, jsonb, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.reconcile_canonical_listing_decision(uuid, uuid, text, jsonb, jsonb, text, text, uuid, timestamptz) to service_role;

commit;
