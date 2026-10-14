-- STOP of unattended OLX in the database (instant, no deployment).
-- After this the scheduled Worker's every claim answers AUTOMATION_DISABLED
-- and nothing new is scraped. A job already running finishes normally (at most
-- one, at most ~4 min). Finder's portals, Price Radar and manual scans are not
-- affected. Re-enable: scripts/olx-cloud-scheduled.enable.sql.
update public.olx_automation_control
   set scheduled_claim_enabled = false, note = 'STOP ' || now()::text, updated_at = now()
 where id = 1;

select scheduled_claim_enabled, max_claims_24h, unclaimed_expiry_minutes, note, updated_at
  from public.olx_automation_control;
