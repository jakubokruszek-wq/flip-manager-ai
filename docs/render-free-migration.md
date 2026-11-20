# Render Free migration — prepared, not deployed

Base: main at 05f2eb3360f1d3d6e6597f39c49ca58c1a09b5f7.

The Blueprint creates one free Node.js web service. Existing Supabase database,
Storage, users, device rows and offer data remain in place. It does not run
migrations, provision a database, rotate credentials, change Vercel, or schedule
duplicate scans. Automatic deploys are disabled.

## Deployment blockers

Render MCP authentication did not complete: two attempts returned
"Authentication for Render was requested and accepted. Retry this tool call now."
No service has been created and no Render workspace has been selected.

Connect Render, then confirm its target workspace and inventory before creating
the service. CLI/API platform validation and a full production build are still
required; local YAML checks alone do not prove runtime readiness.

## Configuration

Copy the existing production values using secure provider tools, never chat or
tracked files. Required core keys are declared as sync:false in render.yaml:
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
SUPABASE_SERVICE_ROLE_KEY, FLIP_COLLECTOR_PAIRING_SECRET.
The Supabase URL and publishable key must be set before building Next.js.

Inventory all other production keys by name and preserve those needed by optional
features (AI, push notifications, worker authentication, scheduled tasks).
Do not generate replacements for existing pairing/signing secrets.
SUPABASE_SECRET_KEY is an alternative supported by part of the app; the admin
client also requires SUPABASE_SERVICE_ROLE_KEY. Verify the actual current setup.

After a service URL exists, review Supabase Auth redirect allowlists and any
absolute callback URLs, server-action origin restrictions, scheduler callers,
and worker endpoints. Expect a new browser login on the new host.

## Free-plan behavior

Render Free sleeps after 15 idle minutes; startup can take about a minute.
Watcher currently has 10-second connection and 15-second read timeouts.
Before cutover, implement bounded cold-start retries without resetting the scan
cycle or sending duplicate offers. Test a genuinely sleeping service.

The Android client pins https://flip-manager-ai.vercel.app in WatcherLink and
validates pairing origins. Do not redirect credentials to an arbitrary URL.
Prepare a signed Android update only after the new HTTPS origin is known,
auditing all report/upload/pairing URLs and preserving encrypted device data.

Vercel's vercel.json cron does not run on Render. Inventory existing GitHub
scheduler workflows and other callers before switching their origin; configure
one intended scheduler, avoiding duplicate jobs. No paid Render cron is included.
Free Render bandwidth/build/RAM limits remain; inspect actual usage.

## Verification before cutover

1. Validate Blueprint with Render CLI/API and build the exact branch.
2. Verify login, operator authorization, list/group endpoints, actual photo
   display and normal report/upload flow without publishing artificial offers.
3. Reconcile existing offer/device identities and image URLs against Supabase.
4. Test signed Watcher upgrade without uninstall/data clearing, normal and
   cold-start requests, idempotent retries and schedule behavior.
5. Switch real callers only after end-to-end checks. Retain the old deployment
   and existing database throughout rollback; no database restore is required
   for this hosting-only configuration.

No claim is made yet that this workload fits the free plan or that the migration
is live.
