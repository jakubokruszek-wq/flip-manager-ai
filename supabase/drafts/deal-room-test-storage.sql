-- RETIRED APPLICATION FEATURE: kept for CI security regressions only. Do not install or reactivate in production.
-- REVIEW ONLY v1. No production execution authorized. Independent of deal-room-qa.sql.
-- No references, writes, triggers or reads to real listings/deals/comparables/queues.
begin;
create table public.deal_room_test_cases (
 owner_id uuid not null references auth.users(id) on delete restrict,
 case_id uuid not null check (case_id::text like 'deadbeef-%'),
 fixture_version integer not null default 1 check(fixture_version=1),
 version integer not null default 1 check(version>0),
 deal jsonb not null check(jsonb_typeof(deal)='object' and (deal->>'id') is not distinct from case_id::text and (deal->>'listingId') is not distinct from case_id::text),
 state jsonb not null check(jsonb_typeof(state)='object'),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(owner_id,case_id),
 check(coalesce(deal#>>'{ceo,result,action}','') in ('HOLD / ZBIERZ DANE','ODRZUĆ')),
 check(pg_column_size(deal)<4000000 and pg_column_size(state)<4000000)
);
create table public.deal_room_test_rounds (
 owner_id uuid not null,case_id uuid not null,request_id uuid not null,
 payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 response jsonb not null check(jsonb_typeof(response)='object' and pg_column_size(response)<8000000),
 created_at timestamptz not null default now(),
 primary key(owner_id,case_id,request_id),
 foreign key(owner_id,case_id) references public.deal_room_test_cases(owner_id,case_id) on delete restrict
);
create index deal_room_test_rounds_history on public.deal_room_test_rounds(owner_id,case_id,created_at desc,request_id desc);
alter table public.deal_room_test_cases enable row level security;
alter table public.deal_room_test_cases force row level security;
alter table public.deal_room_test_rounds enable row level security;
alter table public.deal_room_test_rounds force row level security;
revoke all on public.deal_room_test_cases,public.deal_room_test_rounds from public,anon,authenticated;
-- Server gateway alone binds verified actor; service_role bypasses RLS. No browser direct table access.
grant select,insert,update on public.deal_room_test_cases to service_role;
grant select,insert on public.deal_room_test_rounds to service_role;

create function public.deal_room_test_contract() returns integer language sql stable security invoker
set search_path=pg_catalog as $$ select 1 $$;
revoke all on function public.deal_room_test_contract() from public,anon,authenticated;
grant execute on function public.deal_room_test_contract() to service_role;

create function public.deal_room_test_commit(p_owner_id uuid,p_case_id uuid,p_expected_version integer,p_request_id uuid,p_payload_hash text,p_deal jsonb,p_state jsonb,p_response jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_case public.deal_room_test_cases%rowtype;v_replay public.deal_room_test_rounds%rowtype;
begin
 if p_owner_id is null or p_case_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1
 or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then raise exception 'TEST_INVALID';end if;
 select * into v_case from public.deal_room_test_cases where owner_id=p_owner_id and case_id=p_case_id for update;
 if not found then raise exception 'TEST_NOT_FOUND';end if;
 select * into v_replay from public.deal_room_test_rounds where owner_id=p_owner_id and case_id=p_case_id and request_id=p_request_id;
 if found then
  if v_replay.payload_hash<>p_payload_hash then raise exception 'INVESTMENT_DEAL_VERSION_CONFLICT';end if;
  return v_replay.response;
 end if;
 if v_case.version<>p_expected_version then raise exception 'INVESTMENT_DEAL_VERSION_CONFLICT';end if;
 if jsonb_typeof(p_deal) is distinct from 'object' or jsonb_typeof(p_state) is distinct from 'object' or jsonb_typeof(p_response) is distinct from 'object'
 or p_deal->>'id' is distinct from p_case_id::text or p_deal->>'listingId' is distinct from p_case_id::text
 or p_response->'deal' is distinct from p_deal or (p_response->'room'->>'version')::integer is distinct from p_expected_version+1
 or p_response->'room' is distinct from (p_state||jsonb_build_object('version',p_expected_version+1))
 or coalesce(p_deal->'ceo'->'result'->>'action','') not in ('HOLD / ZBIERZ DANE','ODRZUĆ') then raise exception 'TEST_INVALID';end if;
 update public.deal_room_test_cases set deal=p_deal,state=p_state,version=version+1,updated_at=now() where owner_id=p_owner_id and case_id=p_case_id;
 insert into public.deal_room_test_rounds(owner_id,case_id,request_id,payload_hash,response) values(p_owner_id,p_case_id,p_request_id,p_payload_hash,p_response);
 return p_response;
end;$$;
revoke all on function public.deal_room_test_commit(uuid,uuid,integer,uuid,text,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.deal_room_test_commit(uuid,uuid,integer,uuid,text,jsonb,jsonb,jsonb) to service_role;
commit;
