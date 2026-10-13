-- DRAFT — requires operator approval before it is applied to Production.
--
-- Operator confirmation of a listing's building type for the Finder's
-- "Do weryfikacji budynku" queue. Kept outside public.listings because every
-- scan rewrites listings.building_type from source data; an operator decision
-- must survive re-imports. No existing data is modified or deleted.
begin;

create table if not exists public.finder_building_type_confirmations (
  listing_id uuid primary key references public.listings(id) on delete cascade,
  building_type text not null check (building_type in ('blok', 'apartamentowiec', 'kamienica', 'dom', 'loft', 'plomba')),
  confirmed_by uuid not null,
  confirmed_at timestamptz not null default now(),
  note text check (note is null or char_length(note) <= 500)
);

comment on table public.finder_building_type_confirmations is
  'Operator-confirmed building type per listing. Wins over source data and listing text in Finder qualification.';

alter table public.finder_building_type_confirmations enable row level security;
revoke all on table public.finder_building_type_confirmations from public, anon, authenticated;
-- The Finder read path uses the operator's session client (same as listings).
grant select on table public.finder_building_type_confirmations to authenticated;
-- Writes only through the operator-authorized server route (service role).
grant select, insert, update, delete on table public.finder_building_type_confirmations to service_role;

drop policy if exists finder_building_type_confirmations_read on public.finder_building_type_confirmations;
create policy finder_building_type_confirmations_read
  on public.finder_building_type_confirmations
  for select to authenticated
  using (true);

commit;
