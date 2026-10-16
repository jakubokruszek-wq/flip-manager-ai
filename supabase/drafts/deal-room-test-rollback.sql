-- REVIEW ONLY; after separately approved flag-off. Retain all data and Auth FKs.
-- No production execution authorized by implementation task. No DROP/DELETE/CASCADE.
begin;
revoke execute on function public.deal_room_test_contract() from service_role;
revoke execute on function public.deal_room_test_commit(uuid,uuid,integer,uuid,text,jsonb,jsonb,jsonb) from service_role;
revoke insert,update on public.deal_room_test_cases from service_role;
revoke insert on public.deal_room_test_rounds from service_role;
commit;
