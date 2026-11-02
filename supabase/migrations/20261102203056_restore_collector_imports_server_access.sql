-- Device authentication and photo uploads succeeded, but imports returned 503:
-- service_role had no SELECT/INSERT/UPDATE privilege on the import receipt table.
-- Explicitly grant only the operations used by the server-side importer.
-- Keep existing RLS and browser-role grants unchanged.
grant select, insert, update on table public.collector_imports to service_role;
