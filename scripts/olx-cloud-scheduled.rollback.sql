-- Rollback of supabase/migrations/20261015120000_add_scheduled_olx_claim.sql.
-- First STOP the scheduled Worker (workflow "OLX Cloudflare — automat",
-- action: disable). Without the function the endpoint answers 503
-- OLX_SCHEDULED_CLAIM_UNAVAILABLE and nothing is claimed (fail closed).
-- OLX jobs, their history and every other table are kept.
begin;

drop function if exists public.claim_scheduled_finder_olx_job(text, integer);
drop function if exists public.expire_stale_scheduled_finder_olx_jobs();
drop table if exists public.olx_automation_control;

commit;
