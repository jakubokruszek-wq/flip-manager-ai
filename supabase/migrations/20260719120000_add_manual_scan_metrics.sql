begin;

alter table public.source_scans
  add column if not exists scanned_count integer not null default 0 check (scanned_count >= 0),
  add column if not exists matched_count integer not null default 0 check (matched_count >= 0),
  add column if not exists new_count integer not null default 0 check (new_count >= 0),
  add column if not exists price_drop_count integer not null default 0 check (price_drop_count >= 0),
  add column if not exists warnings jsonb not null default '[]'::jsonb;

commit;
