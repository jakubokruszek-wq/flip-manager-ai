begin;

alter table public.properties
  add column if not exists building_type text,
  add column if not exists ownership text,
  add column if not exists rent numeric,
  add column if not exists district text,
  add column if not exists original_url text,
  add column if not exists source text,
  add column if not exists images jsonb not null default '[]'::jsonb;

alter table public.properties enable row level security;

-- WYŁĄCZNIE PRYWATNA WERSJA DEVELOPERSKA.
-- Aplikacja nie ma jeszcze logowania, więc rola anon ma pełny dostęp do tabeli.
-- Przed publicznym wdrożeniem należy dodać logowanie i ograniczyć polityki do rekordów użytkownika.
grant select, insert, update, delete on table public.properties to anon;

drop policy if exists "properties_select_development" on public.properties;

drop policy if exists "properties_insert_development" on public.properties;

drop policy if exists "properties_update_development" on public.properties;

drop policy if exists "properties_delete_development" on public.properties;

create policy "properties_select_development"
  on public.properties
  for select
  to anon
  using (true);

create policy "properties_insert_development"
  on public.properties
  for insert
  to anon
  with check (true);

create policy "properties_update_development"
  on public.properties
  for update
  to anon
  using (true)
  with check (true);

create policy "properties_delete_development"
  on public.properties
  for delete
  to anon
  using (true);

commit;
