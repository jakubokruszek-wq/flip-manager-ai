begin;

-- LOCAL DRAFT ONLY. Fixes stop requests for active runs whose cursor has
-- advanced to the end of sourceQueue while sourceStatuses still contains
-- pending work. The run row, not the current source pointer, is the stop
-- authority. No Radar observations or history are deleted.
create or replace function public.request_price_radar_run_stop(
  p_owner_id uuid,
  p_run_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  current_run public.price_radar_runs%rowtype;
  source_queue jsonb;
  v_source_statuses jsonb;
  source_id text;
  running_source_exists boolean := false;
  queued_job_id uuid;
  stop_now boolean := false;
begin
  if p_owner_id is null or p_run_id is null then raise exception 'owner and run are required'; end if;

  select * into current_run from public.price_radar_runs r
   where r.id = p_run_id and r.owner_id = p_owner_id for update;
  if not found then return 'run_changed'; end if;
  if current_run.status = 'partial' and current_run.error_message = 'RADAR_STOPPED_BY_OPERATOR'
     and current_run.stop_requested_at is not null then return 'stopped'; end if;
  if current_run.status not in ('pending', 'running') then return 'not_active'; end if;

  source_queue := case when jsonb_typeof(current_run.checkpoint->'sourceQueue') = 'array'
    then current_run.checkpoint->'sourceQueue' else '[]'::jsonb end;
  v_source_statuses := case when jsonb_typeof(current_run.checkpoint->'sourceStatuses') = 'object'
    then current_run.checkpoint->'sourceStatuses' else '{}'::jsonb end;

  -- Prefer the source that is actually running. If the saved cursor is stale
  -- or points past the array, use the first unfinished source in queue order.
  -- A missing/currently completed pointer is never a reason to reject STOP.
  select q.value into source_id
    from jsonb_array_elements_text(source_queue) with ordinality as q(value, ordinal)
   where coalesce(v_source_statuses->>q.value, '') in ('running', 'pending')
   order by case when v_source_statuses->>q.value = 'running' then 0 else 1 end, q.ordinal
   limit 1;
  select exists (
    select 1 from jsonb_array_elements_text(source_queue) as q(value)
     where v_source_statuses->>q.value = 'running'
  ) into running_source_exists;

  -- Persist STOP before touching the job or checkpoint. A live source worker
  -- will acknowledge through the existing lease-fenced checkpoint RPC.
  update public.price_radar_runs r set stop_requested_at = coalesce(r.stop_requested_at, now())
   where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('pending', 'running');
  if not found then return 'run_changed'; end if;
  current_run.stop_requested_at := coalesce(current_run.stop_requested_at, now());

  -- A queued OLX reservation has no worker to acknowledge STOP. Cancel only
  -- the job belonging to this exact Radar run; never create or touch a Finder
  -- job. Its existing idempotency row remains in history for operator resume.
  if source_id = 'olx' then
    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR',
      error_message = 'Operator stopped this Radar run before the OLX job was claimed'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
       and j.status = 'queued'
     returning j.id into queued_job_id;
    if queued_job_id is not null then stop_now := true; end if;
  end if;

  -- There is no source worker to acknowledge if no source is marked running.
  -- Finalize immediately in that case (including cursor==queue length with
  -- pending sources), instead of leaving an idle lease to look like a scan.
  if not running_source_exists or current_run.lease_until is null or current_run.lease_until <= now() then
    stop_now := true;
  end if;

  if stop_now then
    -- Return only actually running sources to pending. Completed and failed
    -- sources, pending work, all cursors, and all counters are preserved.
    for source_id in
      select q.value from jsonb_array_elements_text(source_queue) with ordinality as q(value, ordinal)
       where v_source_statuses->>q.value = 'running' order by q.ordinal
    loop
      v_source_statuses := jsonb_set(v_source_statuses, array[source_id], '"pending"'::jsonb, true);
      current_run.source_statuses := jsonb_set(coalesce(current_run.source_statuses, '{}'::jsonb), array[source_id], '"pending"'::jsonb, true);
    end loop;

    update public.olx_scan_jobs j set status = 'failed', finished_at = now(), leased_until = null,
      heartbeat_at = now(), error_code = 'RADAR_STOPPED_BY_OPERATOR',
      error_message = 'Operator stopped this Radar run'
     where j.context_type = 'price_radar' and j.radar_owner_id = p_owner_id and j.radar_run_id = p_run_id
       and j.status = 'running';

    update public.price_radar_runs r set status = 'partial', error_message = 'RADAR_STOPPED_BY_OPERATOR',
      checkpoint = jsonb_set(current_run.checkpoint, '{sourceStatuses}', v_source_statuses, true),
      source_statuses = current_run.source_statuses, finished_at = now(), lease_token = null, lease_until = null
     where r.id = p_run_id and r.owner_id = p_owner_id and r.status in ('pending', 'running')
       and r.stop_requested_at is not null;
    if not found then return 'run_changed'; end if;
    return 'stopped';
  end if;

  return 'stopping';
end;
$$;

revoke all on function public.request_price_radar_run_stop(uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_price_radar_run_stop(uuid, uuid) to service_role;

commit;
