-- DRAFT — requires operator approval before it is applied to Production.
--
-- features/facebook-worker/auth.ts deletes expired nonces on every signed
-- worker request: DELETE ... WHERE expires_at < now(). PostgreSQL requires
-- SELECT privilege on every column referenced in a DELETE's WHERE clause,
-- but 20260811233000 granted service_role only INSERT and DELETE on this
-- table (OLX and Collector nonce tables do have SELECT). Without it the
-- cleanup fails with "permission denied" and its error was ignored, which is
-- consistent with the 74 034 expired rows observed on 2026-10-13. Verify
-- first (read-only):
--   select has_table_privilege('service_role', 'public.facebook_worker_nonces', 'SELECT');
-- Narrowest fix: column-level SELECT on the two columns the cleanup and the
-- replay check reference. anon/authenticated stay fully revoked.
begin;

grant select (nonce, expires_at) on table public.facebook_worker_nonces to service_role;

commit;
