begin;

-- Add only bounded client event diagnostics. This ledger remains isolated from
-- gallery jobs, listing lifecycle, memberships, images, and all business state.
alter table public.gallery_request_traces
  add column if not exists instance_id text,
  add column if not exists action_stage text,
  add column if not exists error_name text,
  add column if not exists error_message text,
  add column if not exists closest_button_found boolean;

alter table public.gallery_request_traces
  drop constraint if exists gallery_request_traces_event_check;

alter table public.gallery_request_traces
  add constraint gallery_request_traces_event_check check (event in (
    'GALLERY_BUTTON_RENDERED',
    'GALLERY_BUTTON_MOUNT',
    'GALLERY_BUTTON_UNMOUNT',
    'GALLERY_NATIVE_POINTER_CAPTURE',
    'GALLERY_NATIVE_CLICK_CAPTURE',
    'GALLERY_CLIENT_EXCEPTION',
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
  drop constraint if exists gallery_request_traces_instance_id_check,
  drop constraint if exists gallery_request_traces_action_stage_check,
  drop constraint if exists gallery_request_traces_error_name_check,
  drop constraint if exists gallery_request_traces_error_message_check;

alter table public.gallery_request_traces
  add constraint gallery_request_traces_instance_id_check check (instance_id is null or char_length(instance_id) between 8 and 80),
  add constraint gallery_request_traces_action_stage_check check (action_stage is null or char_length(action_stage) between 1 and 60),
  add constraint gallery_request_traces_error_name_check check (error_name is null or char_length(error_name) between 1 and 60),
  add constraint gallery_request_traces_error_message_check check (error_message is null or char_length(error_message) between 1 and 160);

-- Keep browser roles at zero direct table access. Server routes use the
-- service-role client and need append/read only; UPDATE/DELETE stay revoked.
alter table public.gallery_request_traces enable row level security;
revoke all on table public.gallery_request_traces from anon, authenticated;
revoke update, delete on table public.gallery_request_traces from service_role;
grant select, insert on table public.gallery_request_traces to service_role;

commit;
