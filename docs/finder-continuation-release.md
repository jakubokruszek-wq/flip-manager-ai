# Finder continuation release

The browser continues only the run returned by the operator's initial click.
`POST /api/flip-finder/scans/{runId}/continue` requires an operator session,
awaits a bounded portion, and never reserves another run or queues OLX/Facebook.
Progress is read again after each portion. Leaving the page aborts client
requests; persisted checkpoints can still be resumed by the service scheduler.

Each source stores the next page/site and the remaining parsed listings in
`source_scans.filter_snapshot._finderCheckpoint`. Completed pages are skipped.
Checkpoints and finalization require the current unexpired lease token.
Budget yields are immediately eligible; actual fetch timeouts use bounded
backoff, and HTTP 403 is terminal. A crash after persistence but before its
checkpoint can repeat that individual idempotent write, never create a new run.

The local implementation retains 60-second route limits. Fluid Compute's
availability for the actual Vercel project has not been confirmed.

## Production setup (not performed by local tests)

1. Deploy the reviewed commit and verify its exact SHA via `/api/build-info`.
2. In an authorized Supabase session, check availability of `pg_cron`,
   `pg_net` and Vault. No extension is installed by the draft.
3. Create the Vault secret `finder_cron_secret` using the UI, matching
   Vercel's existing `FINDER_CRON_SECRET`. Do not print either value.
4. Review and run `scripts/configure-finder-cron.sql`. This creates/updates
   only two named Finder jobs, each every five minutes. Facebook's cron
   and OLX's queue are untouched. No schema migration is required.
5. After confirming both jobs, set GitHub repository variable
   `FINDER_SCHEDULER_DRIVER=supabase-cron`. Finder's scheduled Actions jobs
   will then skip execution; `workflow_dispatch` stays available with OIDC.
6. Observe two real Cron ticks and inspect the relevant `source_scans` rows.
   Verify one expected run ID, advancing checkpoint/progress, terminal state,
   and no repeated completed sources or duplicate OLX jobs. A 202 response or
   Cron `succeeded` alone confirms delivery only, not scan completion.

When the page is closed, new scans use `finder_scan_interval_minutes` through
the existing server scheduler. Pending/running Finder rows block a new run;
continuation handles them independently. `scan_interval_minutes` continues
to belong to Facebook Watcher.

Do not run a test scan without separate authorization for its portal reads
and database writes. Do not infer the current Production run from an old
screenshot. This draft and offline tests do not prove Production setup.

Concurrency regressions force overlapping application requests against a
database simulator and check the real query predicates. They do not prove
parallel transactions on Production PostgreSQL. Existing SQL harness tests
also keep their actual database boundary explicit.

## Local validation

The complete non-browser Finder/Watcher selection passed 962 tests; the
subsequent targeted OIDC, SQL configuration and final continuation/filter
selection passed 37 tests. The new service-filter test checks the actual
mapper, supplied admin client and abort signal rather than its wrapper mock.
All six browser files were exercised sequentially. Four passed directly;
the two affected files were rerun after correcting the isolated fixture key
and request/navigation synchronization, with 15/15 passing. Assertions for
unexpected HTTP/console errors and duplicate requests remain enabled.

Browser builds ran with `NODE_OPTIONS=--require ./features/test-support/offline-next.cjs`.
That preload forbids dotenv reads and non-loopback fetches, supplies installed
local font assets, and uses known mock admin keys only for loopback Supabase.
The real build completed compilation, type validation and prerendering.
TypeScript, ESLint of changed/new code and `git diff --check` also passed.

Reproduction commands (PowerShell, from the repository root):

```powershell
$env:NODE_OPTIONS='--require ./features/test-support/offline-next.cjs'
$env:NEXT_TELEMETRY_DISABLED='1'
$tests = @(rg --files features/flip-finder features/facebook-watcher | Where-Object { $_ -match '\.test\.(ts|tsx|cjs|mjs)$' -and $_ -notmatch '\.browser\.test\.' })
node --import ./scripts/test-alias-loader.mjs --experimental-strip-types --experimental-test-module-mocks --test --test-concurrency=2 @tests
node --import ./scripts/test-alias-loader.mjs --experimental-strip-types --experimental-test-module-mocks --test features/flip-finder/server/finder-cron-configuration.test.ts features/flip-finder/server/finder-run-portion.test.ts features/flip-finder/server/search-filters-source-gate.test.ts features/auth/github-actions-oidc.test.ts
node --test --test-concurrency=1 features/facebook-watcher/components/facebook-watcher-panel.browser.test.cjs features/flip-finder/components/scan-lock-progress.browser.test.cjs
node ./node_modules/typescript/bin/tsc --noEmit -p .
```

The latest checkout contains one more unit test than the 962-test full run;
that addition and the final affected code were covered by the 37-test rerun.
Each browser harness creates its own loopback Supabase server and performs
`next build` with the isolation preload; do not substitute Production keys.
Official detail cursors use a bounded index in the public result list; changes
in that list between portions are not an immutable snapshot guarantee.

Production deployment/configuration, actual extension availability, two
delivered Cron ticks and a terminal real run remain unverified. They require
authorized administrative access; no such operations were performed locally.
