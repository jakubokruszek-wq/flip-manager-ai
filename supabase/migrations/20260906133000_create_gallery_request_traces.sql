begin;

-- Backend-only, bounded diagnostics for a single on-demand gallery request.
-- This table is deliberately separate from business state and membership audit.
create table if not exists public.gallery_request_traces (
  id uuid primary key default gen_random_uuid(),
  trace_id text not null check (trace_id ~ '^[A-Za-z0-9-]{8,80}$'),
  listing_id uuid not null,
  post_id text check (post_id is null or post_id ~ '^[0-9]{5,30}$'),
  event text not null check (event in (
    'GALLERY_CARD_POINTER_CAPTURE',
    'GALLERY_BUTTON_POINTER_CAPTURE',
    'GALLERY_CARD_CLICK_CAPTURE',
    'GALLERY_BUTTON_CLICK_CAPTURE',
    'GALLERY_UI_CLICK',
    'GALLERY_HANDLER_ENTER',
    'GALLERY_GUARD_PASS',
    'GALLERY_GUARD_BLOCKED',
    'GALLERY_FETCH_START',
    'GALLERY_FETCH_RESPONSE',
    'GALLERY_FETCH_ERROR'
  )),
  gallery_status text not null check (gallery_status in ('NOT_REQUESTED', 'PENDING', 'RUNNING', 'PARTIAL', 'COMPLETE', 'FAILED')),
  client_timestamp timestamptz,
  target_tag text,
  current_target_tag text,
  disabled boolean,
  pointer_events text,
  guard_reason text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  response_ok boolean,
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists gallery_request_traces_listing_created_idx
  on public.gallery_request_traces (listing_id, created_at desc);

create index if not exists gallery_request_traces_trace_created_idx
  on public.gallery_request_traces (trace_id, created_at asc);

alter table public.gallery_request_traces enable row level security;
revoke all on table public.gallery_request_traces from anon, authenticated;
grant select, insert on table public.gallery_request_traces to service_role;

commit;
