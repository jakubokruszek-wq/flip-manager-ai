begin;

-- The lifecycle cleanup is invoked only by the trusted server scheduler. Keep
-- it invoker-security so its writes remain subject to the caller's table
-- privileges, and pin name resolution for the untrusted-input boundary.
alter function public.cleanup_listing_visibility_lifecycle(timestamptz)
  set search_path = public;

revoke execute on function public.cleanup_listing_visibility_lifecycle(timestamptz)
  from public, anon, authenticated;
grant execute on function public.cleanup_listing_visibility_lifecycle(timestamptz)
  to service_role;

-- Browser/public PostgREST clients must not be able to mutate listing state
-- around the RPC. All legitimate listing writes use trusted server clients.
revoke update on table public.listings from public, anon, authenticated;
grant update on table public.listings to service_role;

commit;
