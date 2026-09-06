begin;

-- Lightweight forward audit for filter membership transitions. This is not an
-- event-sourcing log: it only records safe, explainable state changes so a
-- failed scan can never erase the last-known-good result without a trace.
create table if not exists public.listing_filter_match_audit (
  id uuid primary key default gen_random_uuid(),
  search_filter_id uuid not null references public.search_filters(id) on delete cascade,
  listing_id uuid not null references public.listings(id) on delete cascade,
  previous_state text not null check (previous_state in ('MATCHED', 'REVIEW', 'INACTIVE', 'NONE')),
  new_state text not null check (new_state in ('MATCHED', 'REVIEW', 'INACTIVE', 'NONE')),
  reason text not null,
  scan_run_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists listing_filter_match_audit_filter_created_idx
  on public.listing_filter_match_audit (search_filter_id, created_at desc);

create index if not exists listing_filter_match_audit_scan_run_idx
  on public.listing_filter_match_audit (scan_run_id, created_at desc)
  where scan_run_id is not null;

alter table public.listing_filter_match_audit enable row level security;
grant select, insert on table public.listing_filter_match_audit to anon, authenticated;
grant all on table public.listing_filter_match_audit to service_role;

drop policy if exists "listing_filter_match_audit_select_app" on public.listing_filter_match_audit;
create policy "listing_filter_match_audit_select_app"
  on public.listing_filter_match_audit for select to anon, authenticated using (true);

drop policy if exists "listing_filter_match_audit_insert_app" on public.listing_filter_match_audit;
create policy "listing_filter_match_audit_insert_app"
  on public.listing_filter_match_audit for insert to anon, authenticated with check (true);

commit;
