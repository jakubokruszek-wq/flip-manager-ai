begin;

alter table public.listings
  drop constraint if exists listings_source_check;

alter table public.listings
  add constraint listings_source_check
  check (source in ('otodom', 'olx', 'morizon', 'facebook'));

alter table public.source_scans
  drop constraint if exists source_scans_source_check;

alter table public.source_scans
  add constraint source_scans_source_check
  check (source in ('otodom', 'olx', 'morizon', 'facebook'));

commit;
