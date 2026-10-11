begin;

-- A user-ended run is terminal but keeps the existing `partial` database
-- status so this additive migration remains compatible with the deployed
-- status constraint. `user_terminated_at` is the durable, non-resumable marker.
-- Checkpoints, cursors, diagnostics, counters, and Radar listings are retained.
alter table public.price_radar_runs
  add column if not exists user_terminated_at timestamptz;

create or replace function public.terminate_price_radar_run(
  p_owner_id uuid,
  p_run_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_run public.price_radar_runs%rowtype;
  saved_checkpoint jsonb;
  saved_statuses jsonb;
  source_id text;
begin
  if p_owner_id is null or p_run_id is null then
    raise exception 'owner and run are required';
  end if;

  select * into current_run
    from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id
   for update;
  if not found then return 'run_changed'; end if;

  if current_run.user_terminated_at is not null then
    return 'terminated';
  end if;

  if current_run.status not in ('pending', 'running')
     and not (current_run.status = 'partial'
       and current_run.error_message = 'RADAR_STOPPED_BY_OPERATOR'
       and current_run.stop_requested_at is not null) then
    return 'not_active';
  end if;

  saved_checkpoint := current_run.checkpoint;
  saved_statuses := case
    when pg_catalog.jsonb_typeof(current_run.checkpoint->'sourceStatuses') = 'object'
      then current_run.checkpoint->'sourceStatuses'
    else coalesce(current_run.source_statuses, '{}'::jsonb)
  end;

  -- A source interrupted by this operation remains unfinished. Preserve its
  -- cursor and all other statuses/diagnostics; only running becomes pending.
  for source_id in
    select entry.key
      from pg_catalog.jsonb_each_text(saved_statuses) as entry(key, value)
     where entry.value = 'running'
  loop
    saved_statuses := pg_catalog.jsonb_set(saved_statuses, array[source_id], '"pending"'::jsonb, true);
  end loop;
  saved_checkpoint := pg_catalog.jsonb_set(saved_checkpoint, '{sourceStatuses}', saved_statuses, true);

  -- Fence only an OLX job owned by this exact Radar run. Keep the job row and
  -- result summary as history; Finder and other Radar/operator jobs are untouched.
  update public.olx_scan_jobs j
     set status = 'failed', finished_at = pg_catalog.now(), leased_until = null,
         lease_token = null, worker_id = null, heartbeat_at = pg_catalog.now(),
         error_code = 'RADAR_TERMINATED_BY_USER',
         error_message = 'Radar run terminated by its owner',
         result_summary = coalesce(j.result_summary, '{}'::jsonb)
           || pg_catalog.jsonb_build_object('termination_reason', 'user_request', 'terminated_at', pg_catalog.now())
   where j.context_type = 'price_radar'
     and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
     and j.status in ('queued', 'running');

  -- This row lock serializes against checkpoint, listing persistence,
  -- heartbeat, and OLX finalization RPCs. After this commit their existing
  -- status='running'/lease predicates reject late writes. The saved pointer is
  -- deliberately irrelevant, including currentSourceIndex == queue.length.
  update public.price_radar_runs r
     set status = 'partial',
         checkpoint = saved_checkpoint,
         source_statuses = saved_statuses,
         finished_at = pg_catalog.now(),
         lease_token = null,
         lease_until = null,
         user_terminated_at = coalesce(r.user_terminated_at, pg_catalog.now())
   where r.id = p_run_id and r.owner_id = p_owner_id
     and r.status in ('pending', 'running', 'partial')
     and r.user_terminated_at is null;
  if not found then return 'run_changed'; end if;

  return 'terminated';
end;
$$;

revoke all on function public.terminate_price_radar_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.terminate_price_radar_run(uuid, uuid) to service_role;

commit;
