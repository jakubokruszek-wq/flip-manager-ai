begin;

-- Replaces the module/global "last discovery preview" mechanism, which does
-- not survive a Vercel cold start or work across concurrent serverless
-- instances (a POST from the extension's facebook.com tab and a later GET
-- from the Manager tab can land on different instances with no shared
-- memory between them). This table is the only storage for a discovery
-- preview, shared correctly across instances by construction.
--
-- Each row is a short-lived capability: the raw token is never stored, only
-- its SHA-256 hash (token_hash). The token itself is `<id>.<secret>` --
-- `<id>` (this row's own primary key) gives an O(1) lookup, and `<secret>`
-- is compared against token_hash in constant time (see discovery-session.ts)
-- so an attacker who can already reach this table's row (which requires the
-- service_role key, itself never exposed to any client) gains no useful
-- timing signal even in principle.
create table public.facebook_group_discovery_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  device_id uuid references public.collector_devices(id) on delete set null,
  candidates jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint facebook_group_discovery_sessions_candidates_bounded check (
    jsonb_typeof(candidates) = 'array' and jsonb_array_length(candidates) <= 200
  )
);

-- Supports both the opportunistic "delete already-expired sessions" cleanup
-- that runs inline on every session creation (mirroring the existing
-- collector_request_nonces/olx_worker_nonces pattern elsewhere in this
-- codebase -- no separate cron is required) and a lookup that must reject
-- an expired token.
create index facebook_group_discovery_sessions_expires_idx
  on public.facebook_group_discovery_sessions (expires_at);

alter table public.facebook_group_discovery_sessions enable row level security;

-- No policies are defined: RLS with zero policies denies every row to every
-- role except service_role, which bypasses RLS entirely in Postgres/Supabase
-- regardless of policies. The actual access gate is therefore the GRANT
-- below, exactly like every other service_role-only table in this project
-- (gallery_request_traces, olx_scan_jobs, ...) -- anon and authenticated are
-- explicitly revoked and never granted anything on this table, so no direct
-- client (browser or extension) can ever read or write it; every access
-- goes through a protected server route using the admin client.
revoke all on table public.facebook_group_discovery_sessions from anon, authenticated;
grant select, insert, update, delete on table public.facebook_group_discovery_sessions to service_role;

commit;

-- Rollback: `drop table public.facebook_group_discovery_sessions;` -- the
-- table holds only short-lived, disposable preview state (nothing a
-- watched_facebook_groups import depends on afterward), so dropping it has
-- no effect on any already-imported group.
