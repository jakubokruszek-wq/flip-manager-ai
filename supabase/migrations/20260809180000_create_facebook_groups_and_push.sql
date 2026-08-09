begin;

create table if not exists public.watched_facebook_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  url text not null unique check (url ~ '^https://([^/]+\.)?facebook\.com/'),
  city text not null default 'Łódź',
  district text,
  neighborhood text,
  priority text not null default 'normal' check (priority in ('high','normal','low')),
  keywords text[] not null default '{}',
  enabled boolean not null default true,
  access_status text not null default 'MANUAL_IMPORT' check (access_status in ('CONNECTED','MANUAL_IMPORT','AUTH_REQUIRED','UNAVAILABLE')),
  last_checked_at timestamptz,
  imported_posts_count integer not null default 0,
  new_today_count integer not null default 0,
  opportunities_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  enabled boolean not null default true
);

alter table public.alerts add column if not exists area numeric;
alter table public.alerts add column if not exists condition text;
alter table public.alerts add column if not exists group_name text;
alter table public.alerts add column if not exists flags text[] not null default '{}';
alter table public.alerts add column if not exists push_delivered_at timestamptz;

create index if not exists watched_facebook_groups_enabled_priority_idx on public.watched_facebook_groups(enabled, priority);
create index if not exists push_subscriptions_enabled_idx on public.push_subscriptions(enabled) where enabled = true;

alter table public.watched_facebook_groups enable row level security;
alter table public.push_subscriptions enable row level security;
revoke all on table public.watched_facebook_groups from anon, authenticated;
revoke all on table public.push_subscriptions from anon, authenticated;
grant select, insert, update on table public.watched_facebook_groups to service_role;
grant select, insert, update on table public.push_subscriptions to service_role;

commit;
