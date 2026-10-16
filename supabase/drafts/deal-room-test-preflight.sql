-- READ ONLY. No UID guessing. Set owner setting only to a separately verified existing Auth UID.
-- Before applying review-only storage SQL: namespaces/functions must be absent, auth prerequisites present.
select current_setting('server_version') as postgres_version,
 to_regclass('auth.users') is not null as auth_present,
 exists(select 1 from pg_roles where rolname='service_role' and rolbypassrls) as server_role_present,
 to_regclass('public.deal_room_test_cases') as existing_test_cases,
 to_regclass('public.deal_room_test_rounds') as existing_test_rounds,
 to_regprocedure('public.deal_room_test_contract()') as existing_contract,
 to_regprocedure('public.deal_room_test_commit(uuid,uuid,integer,uuid,text,jsonb,jsonb,jsonb)') as existing_commit;
-- Returns only a boolean, no account/email/session records.
select exists(select 1 from auth.users where id::text=current_setting('app.deal_room_test_owner',true)
 and raw_app_meta_data->>'role'='operator') as configured_owner_is_existing_operator;
-- Post-apply metadata audit (also safe before apply: empty result expected).
select c.relname,c.relrowsecurity,c.relforcerowsecurity,
 has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') as anon_has_any,
 has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') as authenticated_has_any,
 (select count(*) from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as user_triggers
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relname in ('deal_room_test_cases','deal_room_test_rounds');
