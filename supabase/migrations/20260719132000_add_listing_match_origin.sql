begin;

alter table public.listing_filter_matches
  add column if not exists match_origin text not null default 'scan',
  add column if not exists source_scan_id uuid references public.source_scans(id) on delete set null;

alter table public.listing_filter_matches
  drop constraint if exists listing_filter_matches_match_origin_check;

alter table public.listing_filter_matches
  add constraint listing_filter_matches_match_origin_check
  check (match_origin in ('scan', 'filter_recalculation'));

create index if not exists listing_filter_matches_filter_origin_idx
  on public.listing_filter_matches (search_filter_id, match_origin);

comment on column public.listing_filter_matches.match_origin is
  'scan = relation created by source scan; filter_recalculation = relation created after filter edit. Private development schema; add user ownership before public deployment.';

commit;
