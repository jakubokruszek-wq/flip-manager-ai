# Price Radar release checks (draft only)

The migration and collection schedule are not applied or activated by this change. These queries are read-only. Run them only after an independently authorized migration in the intended environment; never paste a secret value into SQL, logs, or a report.

## Schema verification

Check the three owner-scoped tables and required columns. Every row returned by this query should have `present = true`:

```sql
with required(table_name, column_name) as (
  values
    ('price_radar_settings','owner_id'), ('price_radar_settings','filters'), ('price_radar_settings','updated_at'),
    ('price_radar_listings','id'), ('price_radar_listings','owner_id'), ('price_radar_listings','source'),
    ('price_radar_listings','external_listing_id'), ('price_radar_listings','original_url'),
    ('price_radar_listings','normalized_url'), ('price_radar_listings','price'), ('price_radar_listings','area'),
    ('price_radar_listings','price_per_sqm'), ('price_radar_listings','market_type'),
    ('price_radar_listings','renovation_status'), ('price_radar_listings','cross_source_identity'),
    ('price_radar_listings','status'), ('price_radar_listings','excluded_at'), ('price_radar_listings','raw_payload'),
    ('price_radar_runs','id'), ('price_radar_runs','owner_id'), ('price_radar_runs','status'),
    ('price_radar_runs','checkpoint'), ('price_radar_runs','source_statuses'), ('price_radar_runs','lease_token'),
    ('price_radar_runs','lease_until'), ('price_radar_runs','scanned_count'), ('price_radar_runs','qualified_count'),
    ('price_radar_runs','started_at'), ('price_radar_runs','finished_at')
)
select r.table_name, r.column_name, (c.column_name is not null) as present
from required r
left join information_schema.columns c
  on c.table_schema = 'public' and c.table_name = r.table_name and c.column_name = r.column_name
order by r.table_name, r.column_name;
```

Check RLS and owner-only read policies. Expect RLS enabled for all three tables and one authenticated SELECT policy per table whose predicate scopes rows to owner_id = auth.uid(). No anonymous write policy should exist.

```sql
select c.relname as table_name, c.relrowsecurity as rls_enabled,
       p.policyname, p.cmd, p.roles, p.qual, p.with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policies p on p.schemaname = n.nspname and p.tablename = c.relname
where n.nspname = 'public'
  and c.relname in ('price_radar_settings','price_radar_listings','price_radar_runs')
order by c.relname, p.policyname;
```

Check the active-run uniqueness guard and OLX context constraint. Expect the partial unique index on price_radar_runs(owner_id) where status is pending/running, plus a context constraint that allows Finder jobs only with Finder references and Radar jobs only with Radar owner/run/lease references.

```sql
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in ('price_radar_runs_one_active_per_owner_idx',
                    'price_radar_listings_owner_source_external_key',
                    'price_radar_listings_owner_source_url_key');

select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.olx_scan_jobs'::regclass
  and conname = 'olx_scan_jobs_context_check';
```

Check RPC security and grants. Expect every listed function to exist, SECURITY DEFINER = true, proconfig to contain search_path=public, anon and authenticated EXECUTE to be false, and service_role EXECUTE to be true.

```sql
select p.oid::regprocedure as function_signature,
       p.prosecdef as security_definer,
       p.proconfig as function_settings,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('claim_price_radar_run','persist_price_radar_listing',
                    'set_price_radar_listing_exclusion','checkpoint_price_radar_run',
                    'heartbeat_price_radar_olx_job','finalize_price_radar_olx_job')
order by p.proname;
```

## Scheduler verification (read-only)

First check whether the extensions and catalogs are available:

```sql
select extname
from pg_extension
where extname in ('pg_cron','pg_net','supabase_vault')
order by extname;

select to_regclass('cron.job') as cron_job_catalog,
       to_regclass('vault.secrets') as vault_secret_catalog;
```

Only if cron.job exists, check schedule names without selecting command text. Expect no price-radar job until a separate explicit activation; existing unrelated jobs must remain unchanged.

```sql
select jobid, jobname, schedule, active
from cron.job
where jobname ilike '%price-radar%'
order by jobname;
```

Never select vault.decrypted_secrets.decrypted_secret. If secret presence is later authorized, verify the approved secret name only, without reading its value.

## Deployment order

1. Review and separately authorize the draft migration; apply it before deploying code that expects the new tables/RPCs.
2. Run the schema, RLS, RPC, and grant checks above and retain the result without credentials.
3. Complete the two-session PostgreSQL concurrency check in price-radar-local-postgres-concurrency-check.md on an isolated local database; PGlite is not a substitute.
4. Deploy the application commit only after those gates pass. The daily schedule remains inactive in this commit; activating it requires a separate explicit operation after verifying the endpoint, Vault/CRON_SECRET configuration, and absence of an existing duplicate job.

## Rollback

Checked against all three draft migrations (`20261008000000_create_price_radar.sql`, `20261008120000_add_confirmed_property_identity.sql`, `20261009120000_add_finder_identity_evidence_and_manual_groups.sql`) and the full migration history (`supabase/migrations/*.sql`).

### What is genuinely new vs. what replaces a prior definition

Every `create or replace function`, `create policy`, and `grant`/`revoke` statement in the three drafts targets an object that is **created for the first time inside these same three migrations** (confirmed by grepping every function/policy name against the full `supabase/migrations/` history): `price_radar_settings`/`price_radar_listings`/`price_radar_runs` and their policies/grants; `claim_price_radar_run`, `persist_price_radar_listing`, `set_price_radar_listing_exclusion`, `checkpoint_price_radar_run`, `heartbeat_price_radar_olx_job`, `finalize_price_radar_olx_job`; `finder_listing_identity_groups`/`finder_listing_identity_decisions` and their policies/grants; `manage_finder_listing_identity`; `apply_confirmed_property_group_review_decision` (which only *calls* the pre-existing `apply_listing_review_decision` from `20260924204646_harden_listing_lifecycle_rpc.sql` as a fallback — it never redefines it). **No function, policy, or grant anywhere in these three drafts overwrites an already-deployed definition.** `DROP FUNCTION`/`DROP POLICY` on any of the above therefore loses nothing — there is no earlier version to restore.

The three drafts do modify two pre-existing, already-deployed objects on `public.olx_scan_jobs` (created in `20260810190000_create_olx_local_worker_queue.sql`):
- `alter column source_scan_id drop not null`
- `alter column search_filter_id drop not null`

Restoring `set not null` on either column only succeeds if **zero** rows are NULL in that column at the time — i.e. every historical `price_radar`-context job row (which is required by `olx_scan_jobs_context_check` to have NULL `source_scan_id`/`search_filter_id`) must first be deleted or migrated away. This is the one real "undo" step that is data-destructive, and it only destroys Radar *job-queue bookkeeping rows*, never `price_radar_listings`/`price_radar_runs`/`price_radar_settings` data.

The new `olx_scan_jobs_context_check` constraint and the four new `olx_scan_jobs` columns (`context_type`, `radar_owner_id`, `radar_run_id`, `radar_lease_token`) are first defined here too (the `drop constraint if exists` before creating it is only defensive re-run safety within this same migration, not evidence of an earlier differently-defined constraint) — dropping them loses nothing.

### Old-code / new-schema compatibility (verified against the last deployed commit, `d8c6a86d`)

All additive columns and format/unique CHECK constraints on `listings.cross_source_identity`, `listings.identity_evidence`, and `properties.cross_source_identity` are safe for old code: code from before these migrations never writes them, so they stay `NULL`, and every new constraint explicitly allows `NULL`. The partial unique index on `properties.cross_source_identity` never fires for `NULL`. `claim_olx_scan_job` (unchanged, pre-existing) returns `setof public.olx_scan_jobs` and uses `select *` / `returning *`, so it automatically picks up the new `olx_scan_jobs` columns without being redefined — confirmed by reading its body, not assumed.

**One real compatibility risk**, found by diffing `features/flip-finder/server/olx-jobs.ts` between `d8c6a86d` and `HEAD`: the pre-Radar `claimOlxJob` parses the claimed row with `requiredString(row.source_scan_id, ...)` and `requiredString(row.search_filter_id, ...)`, which **throw** if those are `NULL`. `claim_olx_scan_job` claims the oldest `queued` row regardless of `context_type`. So: **if the application code is rolled back to a pre-Radar release while a `price_radar`-context job is still `queued`/`running` in the shared `olx_scan_jobs` table, the old worker route will repeatedly claim that one job, throw, and let its lease expire — blocking every other queued job (including genuine Finder OLX scans queued behind it in FIFO order) until that job exhausts `max_attempts` (default 3) and is marked `failed`.** This is bounded and self-recovering (not silent corruption), but it is a real, temporary head-of-line stall, not a non-issue.

### Recommended rollback (preserves all data)

1. Stop the Radar schedule (there is currently no cron entry in `vercel.json` and no Supabase `cron.job` row for this endpoint — confirm that with the read-only queries above; if one was separately activated, disable it first).
2. Drain the shared OLX queue of Radar-context jobs before rolling back code that doesn't understand `context_type`: `update public.olx_scan_jobs set status = 'failed', finished_at = now(), error_code = 'RADAR_ROLLBACK_DRAIN', leased_until = null, lease_token = null where context_type = 'price_radar' and status in ('queued','running');` (read-only check first: count rows matching that filter; only run the update under the same authorization as any other Production write). This removes the head-of-line-block risk identified above.
3. Revert the application deployment to the last known-good release. Do **not** run any `drop table`/`drop function`/`drop policy` — leave all three migrations applied.
4. `price_radar_settings`, `price_radar_listings`, `price_radar_runs`, `finder_listing_identity_groups`, `finder_listing_identity_decisions`, and the `cross_source_identity`/`identity_evidence` columns all remain untouched and fully readable; no Radar listing, run, setting, Finder identity group, or manual link/unlink decision is deleted by this path.
5. Re-verify with the schema/RLS/RPC checks above that the retained schema still matches expectations before re-attempting a forward deploy.

### Separate, explicitly destructive schema-removal plan (only for permanently abandoning the feature, never as a routine deploy rollback)

Only after confirming no code path still reads these objects. Drop in dependency order:
1. `drop function if exists public.manage_finder_listing_identity(uuid, uuid, text, uuid, uuid);`
2. `drop table if exists public.finder_listing_identity_decisions;` then `drop table if exists public.finder_listing_identity_groups;` — **destroys every manual link/unlink/never-link decision.**
3. `drop function if exists public.apply_confirmed_property_group_review_decision(uuid, text, text, timestamptz);`
4. Drop the unique index `properties_cross_source_identity_key`, the two format-check constraints on `listings`/`properties`, then `alter table public.listings drop column if exists identity_evidence, drop column if exists cross_source_identity;` and the equivalent on `properties`.
5. `drop function if exists public.finalize_price_radar_olx_job(...)`, `heartbeat_price_radar_olx_job(...)`, `checkpoint_price_radar_run(...)`, `set_price_radar_listing_exclusion(...)`, `persist_price_radar_listing(...)`, `claim_price_radar_run(...)` (exact signatures as granted above).
6. `drop table if exists public.price_radar_runs, public.price_radar_listings, public.price_radar_settings;` — **destroys every collected Radar listing, run history, and saved filter.**
7. On `olx_scan_jobs`: first delete or re-point every `context_type = 'price_radar'` row (there is no way to keep them once `radar_run_id`'s target table is gone — `on delete cascade` from `price_radar_runs` already does this automatically once step 6 runs), then `alter table public.olx_scan_jobs drop constraint if exists olx_scan_jobs_context_check, drop column if exists radar_lease_token, drop column if exists radar_run_id, drop column if exists radar_owner_id, drop column if exists context_type;`, then `alter column source_scan_id set not null, alter column search_filter_id set not null` — only possible once no NULL rows remain, which step 6's cascade guarantees for `olx_scan_jobs` rows whose `radar_run_id` pointed at a deleted run, but **any `price_radar`-context job rows not yet linked to a run row at all would need an explicit `delete` first.**

This path is data-destructive by design (step 2 loses manual Finder identity decisions, step 6 loses all Radar history) and should only be executed as a deliberate feature removal, never silently combined with a code-only rollback.
