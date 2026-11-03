-- The production runtime registers the timer with its existing credential.
-- No credential literal is included in a migration or returned to a client.
-- Vault/cron require their owner, so this small bootstrap has an explicit
-- service-role-only ACL; it is not an operator/anonymous RPC.
create or replace function public.ensure_price_radar_watchdog(p_secret text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  secret_id uuid;
  previous_secret text;
  desired_command constant text := $job$
    select net.http_post(
      url := 'https://flip-manager-ai.vercel.app/api/jobs/price-radar-collect',
      headers := jsonb_build_object(
        'Content-Type','application/json','x-radar-watchdog','1',
        'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='price_radar_cron_secret')),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $job$;
begin
  if p_secret is null or length(p_secret)=0 or length(p_secret)>2048 or p_secret ~ E'[\r\n]' then
    raise exception 'RADAR_WATCHDOG_INVALID_CONFIGURATION';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regclass('cron.job') is null then
    raise exception 'RADAR_WATCHDOG_DEPENDENCIES_MISSING';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price-radar-watchdog-configuration',0));
  select id,decrypted_secret into secret_id,previous_secret
    from vault.decrypted_secrets where name='price_radar_cron_secret';
  if secret_id is null then
    perform vault.create_secret(p_secret,'price_radar_cron_secret','Radar independent server recovery');
  elsif previous_secret is distinct from p_secret then
    perform vault.update_secret(secret_id,p_secret);
  end if;
  if not exists(select 1 from cron.job where jobname='price-radar-watchdog'
    and username=current_user and active and schedule='* * * * *' and command=desired_command) then
    perform cron.schedule('price-radar-watchdog','* * * * *',desired_command);
  end if;
  return true;
end;
$function$;

revoke all on function public.ensure_price_radar_watchdog(text) from public, anon, authenticated;
grant execute on function public.ensure_price_radar_watchdog(text) to service_role;
