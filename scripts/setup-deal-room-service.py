"""Disposable CI-only PostgREST fixture for the actual Investment OS services."""
import os
import runpy
from pathlib import Path
if os.environ.get('GITHUB_ACTIONS') != 'true':
    raise SystemExit('GITHUB_ACTIONS_REQUIRED')
root = Path(__file__).resolve().parents[1]
fixture = runpy.run_path(str(root / 'scripts/test-deal-room-postgres.py'), run_name='deal_room_fixture')
fixture['DealRoomSql'].setUpClass()
with fixture['psycopg'].connect(fixture['DSN'], autocommit=True) as c:
    c.execute('''alter table listings
      add column source text, add column original_url text, add column external_listing_id text,
      add column lifecycle_status text, add column manual_decision text, add column city text,
      add column district text, add column address text, add column area numeric, add column rooms integer,
      add column floor text, add column building_type text, add column ownership text, add column description text,
      add column rent numeric, add column price numeric, add column price_per_sqm numeric,
      add column gallery_status text, add column images jsonb, add column last_seen_at timestamptz;
      create table listing_snapshots(id uuid primary key, listing_id uuid references listings(id), captured_at timestamptz, price numeric, raw_data jsonb);
      create table listing_source_metadata(listing_id uuid primary key references listings(id), source text, metadata jsonb);
      create table resale_comps(id uuid primary key, active boolean);
      grant select, insert, update on listings to service_role;
      grant select on listing_snapshots, listing_source_metadata, resale_comps to service_role;''')
    c.execute("insert into auth.users values ('33333333-3333-4333-8333-333333333333'), ('55555555-5555-4555-8555-555555555555')")
    c.execute('''insert into listings(id,updated_at,source,original_url,external_listing_id,lifecycle_status,city,district,address,area,rooms,floor,building_type,ownership,price,gallery_status,images,last_seen_at)
      values ('22222222-2222-4222-8222-222222222222',now(),'facebook','https://www.facebook.com/groups/12345/posts/67890','67890','ACTIVE','Łódź','Górna','Syntetyczna',45,2,'2','BLOCK','pełna własność',300000,'NOT_REQUESTED','[]',now())''')
    c.execute('''insert into market_assumptions(city,district,building_type,area_min,area_max,rooms,resale_price_per_m2_low,resale_price_per_m2_base,resale_price_per_m2_high,confidence,provenance,effective_from)
      values ('Łódź','Górna','BLOCK',40,50,2,9500,10000,10500,85,'USER_ASSUMPTION',now())''')
    c.execute("create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$")
    # Empty dependency only: the historical Radar migration references the queue.
    # No OLX worker/function is executed by this test and no source implementation changes.
    c.execute("create table olx_scan_jobs(id uuid primary key, source_scan_id uuid not null, search_filter_id uuid not null, scan_run_id uuid)")
    c.execute((root / 'supabase/migrations/20261008000000_create_price_radar.sql').read_text())
    c.execute("insert into price_radar_settings(owner_id,filters) values ('33333333-3333-4333-8333-333333333333', '{\"districts\":[\"Górna\"],\"market\":\"secondary\"}')")
    c.execute('''insert into price_radar_listings(owner_id,source,external_listing_id,original_url,normalized_url,title,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash)
      select '33333333-3333-4333-8333-333333333333','otodom',i::text,'https://www.otodom.pl/pl/oferta/test-ID'||i,'https://www.otodom.pl/pl/oferta/test-ID'||i,'Syntetyczny lokal',(9000+i*50)*45,45,9000+i*50,2,'Łódź','Górna','blok','secondary','fresh_renovation',i::text from generate_series(1,20) i''')
    c.execute('''insert into price_radar_listings(owner_id,source,external_listing_id,original_url,normalized_url,title,price,area,price_per_sqm,rooms,city,district,building_type,market_type,renovation_status,content_hash)
      select '55555555-5555-4555-8555-555555555555',source,external_listing_id,original_url,normalized_url,title,price*2,area,price_per_sqm*2,rooms,city,district,building_type,market_type,renovation_status,content_hash from price_radar_listings where owner_id='33333333-3333-4333-8333-333333333333' ''')
    c.execute("notify pgrst, 'reload schema'")
print('Isolated service fixture ready; no production records or keys used.')
