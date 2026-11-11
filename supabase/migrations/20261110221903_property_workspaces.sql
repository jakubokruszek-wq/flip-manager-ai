-- Additive, owner-scoped investment workspace. No existing property or listing is removed.
create table public.property_workspaces (
 property_id uuid primary key references public.properties(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 version integer not null default 1 check(version>0),
 data jsonb not null check(jsonb_typeof(data)='object' and octet_length(data::text)<=512000 and data ? 'schema' and data ? 'stage' and data->>'schema'='1' and data->>'stage' in ('contact','viewing','analysis','negotiation','acquired','renovation','listed','sold','rejected')),
 updated_at timestamptz not null default now()
);
alter table public.property_workspaces enable row level security;
create policy workspace_read_owner on public.property_workspaces for select to authenticated
 using(owner_id=(select auth.uid()) and (select auth.jwt()->'app_metadata'->>'role')='operator');
revoke all on public.property_workspaces from public,anon,authenticated;
grant select on public.property_workspaces to authenticated;
grant all on public.property_workspaces to service_role;
create index property_workspaces_owner on public.property_workspaces(owner_id);

create table public.property_workspace_files (
 id uuid primary key,
 property_id uuid not null references public.properties(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 name text not null check(length(name) between 1 and 200),
 category text not null check(category in ('viewing','deed','document','before','during','after','visualization','invoice')),
 mime text not null check(mime in ('image/jpeg','image/png','image/webp','application/pdf')),
 size integer not null check(size>0 and size<=12582912),
 path text not null unique,
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 unique(property_id,sha256),
 check(path like owner_id::text||'/'||property_id::text||'/%')
);
alter table public.property_workspace_files enable row level security;
create policy workspace_file_read_owner on public.property_workspace_files for select to authenticated
 using(owner_id=(select auth.uid()) and (select auth.jwt()->'app_metadata'->>'role')='operator');
revoke all on public.property_workspace_files from public,anon,authenticated;
grant select on public.property_workspace_files to authenticated;
grant all on public.property_workspace_files to service_role;
create index property_workspace_files_owner_property on public.property_workspace_files(owner_id,property_id,created_at desc);

create table public.property_workspace_events (
 property_id uuid not null references public.properties(id) on delete cascade,
 version integer not null,
 owner_id uuid not null references auth.users(id),
 stage text not null,
 expense_count integer not null,
 task_count integer not null,
 created_at timestamptz not null default now(),
 primary key(property_id,version)
);
alter table public.property_workspace_events enable row level security;
create policy workspace_event_read_owner on public.property_workspace_events for select to authenticated
 using(owner_id=(select auth.uid()) and (select auth.jwt()->'app_metadata'->>'role')='operator');
revoke all on public.property_workspace_events from public,anon,authenticated;
grant select on public.property_workspace_events to authenticated;
grant all on public.property_workspace_events to service_role;
create index property_workspace_events_owner_property on public.property_workspace_events(owner_id,property_id,version desc);

-- Short-lived reservations bind each direct storage upload to its operator.
create table public.property_workspace_uploads (
 id uuid primary key,
 property_id uuid not null references public.properties(id) on delete cascade,
 owner_id uuid not null references auth.users(id),
 name text not null,
 category text not null,
 mime text not null,
 size integer not null check(size>0 and size<=12582912),
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 path text not null unique,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '2 hours',
 check(path like owner_id::text||'/'||property_id::text||'/%')
);
alter table public.property_workspace_uploads enable row level security;
revoke all on public.property_workspace_uploads from public,anon,authenticated;
grant all on public.property_workspace_uploads to service_role;
create index property_workspace_uploads_owner_expiry on public.property_workspace_uploads(owner_id,expires_at);

-- No public bucket and no client-side object read policies. Server issues 15-minute
-- signed links only after checking operator session, property and document owner.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('property-workspace-private','property-workspace-private',false,12582912,array['image/jpeg','image/png','image/webp','application/pdf']);

-- Called only by the authorized API after full schema/attachment validation.
-- Service-role invoker avoids granting authenticated clients broad property UPDATE.
create function public.save_property_workspace(p_property_id uuid,p_owner_id uuid,p_expected_version integer,p_data jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare v_version integer; v_status text; v_stage text; v_owner uuid;
begin
 if p_owner_id is null or p_expected_version is null or p_expected_version<0 then raise exception 'INVALID_WORKSPACE_SAVE'; end if;
 v_stage:=p_data->>'stage';
 if v_stage in ('acquired','renovation','listed','sold') and (nullif(p_data->>'purchaseDate','') is null or p_data->>'purchasePrice' is null) then raise exception 'PURCHASE_DETAILS_REQUIRED'; end if;
 if v_stage='sold' and (nullif(p_data->>'saleDate','') is null or p_data->>'salePrice' is null) then raise exception 'SALE_DETAILS_REQUIRED'; end if;
 -- Lock the existing property, including first-save races. Acquisition never clones it.
 perform 1 from public.properties where id=p_property_id for update;
 if not found then raise exception 'PROPERTY_NOT_FOUND'; end if;
 select owner_id into v_owner from public.property_workspaces where property_id=p_property_id;
 if v_owner is not null and v_owner<>p_owner_id then raise exception 'WORKSPACE_OWNER_MISMATCH' using errcode='42501'; end if;
 if p_expected_version=0 then
  insert into public.property_workspaces(property_id,owner_id,data) values(p_property_id,p_owner_id,p_data)
  on conflict(property_id) do nothing returning version into v_version;
 else
  update public.property_workspaces set data=p_data,version=version+1,updated_at=now()
   where property_id=p_property_id and owner_id=p_owner_id and version=p_expected_version returning version into v_version;
 end if;
 if v_version is null then raise exception 'WORKSPACE_CONFLICT' using errcode='40001'; end if;
 v_status:=case when v_stage in ('acquired','renovation','listed','sold') then v_stage when v_stage in ('contact','rejected') then 'draft' else 'analysis' end;
 update public.properties set status=v_status where id=p_property_id;
 insert into public.property_workspace_events(property_id,version,owner_id,stage,expense_count,task_count)
 values(p_property_id,v_version,p_owner_id,v_stage,jsonb_array_length(p_data->'expenses'),jsonb_array_length(p_data->'tasks'));
 return v_version;
end $$;
revoke all on function public.save_property_workspace(uuid,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.save_property_workspace(uuid,uuid,integer,jsonb) to service_role;
