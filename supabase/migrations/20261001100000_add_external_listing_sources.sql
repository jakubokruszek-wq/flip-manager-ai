-- Prepared locally for review only. Do not apply without a separately
-- approved Production migration window.
begin;

alter table public.listings
  drop constraint if exists listings_source_check;

alter table public.listings
  add constraint listings_source_check
  check (source in (
    'otodom', 'olx', 'morizon', 'facebook', 'gratka',
    'nieruchomosci_online', 'domiporta', 'sprzedajemy', 'adresowo',
    'oferty_net', 'szybko', 'bezposrednio', 'domy', 'allegro_lokalnie'
  ));

alter table public.source_scans
  drop constraint if exists source_scans_source_check;

alter table public.source_scans
  add constraint source_scans_source_check
  check (source in (
    'otodom', 'olx', 'morizon', 'facebook', 'gratka',
    'nieruchomosci_online', 'domiporta', 'sprzedajemy', 'adresowo',
    'oferty_net', 'szybko', 'bezposrednio', 'domy', 'allegro_lokalnie'
  ));

alter table public.resale_comps
  drop constraint if exists resale_comps_source_check;

alter table public.resale_comps
  add constraint resale_comps_source_check
  check (source in (
    'facebook', 'otodom', 'olx', 'morizon', 'gratka',
    'nieruchomosci_online', 'domiporta', 'sprzedajemy', 'adresowo',
    'oferty_net', 'szybko', 'bezposrednio', 'domy', 'allegro_lokalnie'
  ));

commit;
