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
