begin;

-- Extend the existing backend-only gallery trace ledger with a bounded,
-- render-time probe. Existing diagnostics and business state are preserved.
alter table public.gallery_request_traces
  add column if not exists source text,
  add column if not exists client_build text,
  add column if not exists component text,
  add column if not exists button_rendered boolean;

-- The original inline CHECK is named by PostgreSQL after the table/column.
-- Recreate it idempotently so the render probe is an accepted event.
alter table public.gallery_request_traces
  drop constraint if exists gallery_request_traces_event_check;

alter table public.gallery_request_traces
  add constraint gallery_request_traces_event_check check (event in (
    'GALLERY_BUTTON_RENDERED',
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
  ));

alter table public.gallery_request_traces
  drop constraint if exists gallery_request_traces_source_check,
  drop constraint if exists gallery_request_traces_client_build_check,
  drop constraint if exists gallery_request_traces_component_check;

alter table public.gallery_request_traces
  add constraint gallery_request_traces_source_check check (source is null or source = 'facebook'),
  add constraint gallery_request_traces_client_build_check check (client_build is null or char_length(client_build) between 1 and 120),
  add constraint gallery_request_traces_component_check check (component is null or component = 'GalleryRequestButton');

-- Keep the diagnostics ledger backend-only. Browser roles never receive DB
-- access; server routes use the service_role client.
alter table public.gallery_request_traces enable row level security;
revoke all on table public.gallery_request_traces from anon, authenticated;
grant select, insert on table public.gallery_request_traces to service_role;

commit;
