-- ENABLE of unattended OLX in the database. Run ONLY after the checklist in
-- docs/olx-cloud-scheduled.md §7 (budget verified, Worker deployed DISABLED,
-- /status and selftest green). Enabling here alone scrapes nothing: the
-- scheduled Worker must also be enabled (workflow action "enable").
update public.olx_automation_control
   set scheduled_claim_enabled = true, note = 'ENABLE ' || now()::text, updated_at = now()
 where id = 1;

select scheduled_claim_enabled, max_claims_24h, unclaimed_expiry_minutes, note, updated_at
  from public.olx_automation_control;
