-- Run manually in Supabase before using PATCH /api/properties/[id] with totalFloors.
alter table public.properties
  add column if not exists total_floors integer;
