begin;

-- Preserve the existing source values and make the database ready for the
-- registered external adapters. Runtime activation remains separately gated
-- by SCHEMA_READY_SOURCE_IDS in the application.
alter table public.listings
  drop constraint if exists listings_source_check;

alter table public.listings
  add constraint listings_source_check
  check (source in (
    'otodom',
    'olx',
    'morizon',
    'facebook',
    'gratka',
    'nieruchomosci_online',
    'domiporta',
    'sprzedajemy',
    'adresowo',
    'oferty_net',
    'szybko',
    'bezposrednio',
    'domy',
    'allegro_lokalnie',
    'official_cooperative',
    'official_uml',
    'official_auction'
  ));

alter table public.source_scans
  drop constraint if exists source_scans_source_check;

alter table public.source_scans
  add constraint source_scans_source_check
  check (source in (
    'otodom',
    'olx',
    'morizon',
    'facebook',
    'gratka',
    'nieruchomosci_online',
    'domiporta',
    'sprzedajemy',
    'adresowo',
    'oferty_net',
    'szybko',
    'bezposrednio',
    'domy',
    'allegro_lokalnie',
    'official_cooperative',
    'official_uml',
    'official_auction'
  ));

alter table public.resale_comps
  drop constraint if exists resale_comps_source_check;

alter table public.resale_comps
  add constraint resale_comps_source_check
  check (source in (
    'facebook',
    'otodom',
    'olx',
    'morizon',
    'gratka',
    'nieruchomosci_online',
    'domiporta',
    'sprzedajemy',
    'adresowo',
    'oferty_net',
    'szybko',
    'bezposrednio',
    'domy',
    'allegro_lokalnie',
    'official_cooperative',
    'official_uml',
    'official_auction'
  ));

commit;
