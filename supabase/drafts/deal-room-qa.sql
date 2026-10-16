-- REVIEW DRAFT ONLY. Apply solely to isolated PostgreSQL after the existing Investment OS migrations.
-- No automatic deployment/migration workflow.
alter table public.deals add column deal_room_owner_id uuid references auth.users(id);
create table public.deal_room_workspaces (
  deal_id uuid primary key references public.deals(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);
create table public.deal_room_rounds (
  deal_id uuid not null references public.deals(id) on delete cascade,
  request_id uuid not null,
  owner_id uuid not null references auth.users(id),
  payload_hash text not null,
  response jsonb not null check (jsonb_typeof(response) = 'object'),
  created_at timestamptz not null default now(),
  primary key (deal_id, request_id)
);
alter table public.deal_room_workspaces enable row level security;
alter table public.deal_room_rounds enable row level security;
revoke all on public.deal_room_workspaces, public.deal_room_rounds from public, anon, authenticated;
grant select, insert, update on public.deal_room_workspaces to service_role;
grant select, insert on public.deal_room_rounds to service_role;

create function public.commit_deal_room_round_cas(
  p_deal jsonb, p_expected_version integer, p_source_updated_at timestamptz,
  p_owner_id uuid, p_request_id uuid, p_payload_hash text,
  p_values jsonb, p_state jsonb, p_response jsonb
) returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_deal public.deals%rowtype;
  v_owner uuid;
  v_replay public.deal_room_rounds%rowtype;
  v_version integer;
begin
  if p_owner_id is null or p_request_id is null or p_expected_version is null or p_expected_version < 1
    or p_payload_hash is null or length(p_payload_hash) > 200
    or jsonb_typeof(p_state) is distinct from 'object'
    or jsonb_typeof(p_values) is distinct from 'object'
    or jsonb_typeof(p_response) is distinct from 'object' then
    raise exception 'DEAL_ROOM_INVALID';
  end if;
  select * into v_deal from public.deals where id = (p_deal->>'id')::uuid for update;
  if not found then raise exception 'DEAL_ROOM_NOT_FOUND'; end if;
  if v_deal.deal_room_owner_id is not null and v_deal.deal_room_owner_id <> p_owner_id then raise exception 'DEAL_ROOM_NOT_FOUND'; end if;
  select owner_id into v_owner from public.deal_room_workspaces where deal_id = v_deal.id;
  if v_owner is not null and v_owner <> p_owner_id then raise exception 'DEAL_ROOM_NOT_FOUND'; end if;
  select * into v_replay from public.deal_room_rounds where deal_id = v_deal.id and request_id = p_request_id;
  if found then
    if v_replay.owner_id <> p_owner_id or v_replay.payload_hash <> p_payload_hash then raise exception 'INVESTMENT_DEAL_VERSION_CONFLICT'; end if;
    return v_replay.response;
  end if;
  if v_deal.version <> p_expected_version then raise exception 'INVESTMENT_DEAL_VERSION_CONFLICT'; end if;
  perform 1 from public.listings where id = v_deal.listing_id and updated_at is not distinct from p_source_updated_at for share;
  if not found then raise exception 'INVESTMENT_DEAL_VERSION_CONFLICT'; end if;
  v_version := public.persist_investment_deal_cas(p_deal, p_expected_version, p_source_updated_at);
  if v_version is null then raise exception 'INVESTMENT_DEAL_VERSION_CONFLICT'; end if;
  if (p_response->'room'->>'version')::integer is distinct from v_version
    or p_response->'deal'->>'id' is distinct from v_deal.id::text then raise exception 'DEAL_ROOM_INVALID'; end if;
  update public.deals set deal_room_owner_id = p_owner_id where id = v_deal.id;
  insert into public.deal_fact_overrides(deal_id, values, updated_at) values (v_deal.id, p_values, now())
    on conflict (deal_id) do update set values = excluded.values, updated_at = now();
  insert into public.deal_room_workspaces(deal_id, owner_id, state) values (v_deal.id, p_owner_id, p_state)
    on conflict (deal_id) do update set state = excluded.state, updated_at = now();
  insert into public.deal_room_rounds(deal_id, request_id, owner_id, payload_hash, response)
    values (v_deal.id, p_request_id, p_owner_id, p_payload_hash, p_response);
  return p_response;
end;
$$;
revoke all on function public.commit_deal_room_round_cas(jsonb,integer,timestamptz,uuid,uuid,text,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.commit_deal_room_round_cas(jsonb,integer,timestamptz,uuid,uuid,text,jsonb,jsonb,jsonb) to service_role;
