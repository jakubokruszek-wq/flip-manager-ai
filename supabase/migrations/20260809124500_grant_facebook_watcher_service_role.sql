begin;

-- Secret API keys execute PostgREST requests as service_role. RLS bypass does
-- not replace PostgreSQL table privileges, so grant only the tables required
-- by the server-side Facebook Watcher pipeline.
grant select, insert, update on table public.listings to service_role;
grant select, insert, update on table public.listing_source_metadata to service_role;
grant select, insert, update on table public.listing_filter_matches to service_role;

commit;
