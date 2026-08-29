begin;

-- Collector API routes authenticate and update device health exclusively with
-- the server-side service-role client. Browser clients retain zero table access.
revoke all on table public.collector_devices from anon, authenticated;
grant select, insert, update on table public.collector_devices to service_role;

commit;
