# Watcher 0.7 — remote OFFLINE_TEST proposal, not deployed

## Reviewable infrastructure

Prepared image: `infra/facebook-offline-test/Dockerfile`.
Prepared blueprint: `infra/facebook-offline-test/render.yaml`.
No resource has been created. Applying the blueprint is a remote deployment and
requires explicit user approval, even though it is not a production deployment.

Recommended seven-day test: one NEW Render Free web service (managed HTTPS),
one NEW Supabase project in an organization confirmed to be on Free, one test
phone. Do not use or link production project `zmuisdirvfcxrvtbvrle` or its keys.
No Vercel/Cloudflare configuration changes. No payment method or plan upgrade.
If there is no free project slot, stop; do not fall back to a paid organization.

Checked official options 2026-10-15:

| Option | Cost/limits | Decision |
|---|---|---|
| [Render Free](https://render.com/docs/free) | Free web service with HTTPS; sleeps after 15 min; wake can take about one minute; ephemeral local disk | Suitable API host with external durable DB; no payment method, stop at free quota |
| [Supabase Free](https://supabase.com/pricing) | $0, 2 active projects, 500 MB DB, 5 GB egress; pauses after a week of inactivity | Preferred dedicated test database if a Free slot exists |
| [Neon Free](https://neon.com/pricing) | Free quota without time limit | Alternative needs separate database-role/bootstrap verification; not auto-selected |
| Render Free Postgres | 1 GB, expires after 30 days | Less suitable than a dedicated Supabase Free project for the existing role contract |

Do not use local SQLite or a PostgreSQL container on Render's ephemeral disk:
restarts would erase server receipts and make outbox recovery inconclusive.

## Data and security boundaries

Only 13 SYNTHETIC sources (11 groups, 2 profiles) are seeded. One profile is
UNAVAILABLE. Local HTML deliberately includes an empty source and an error
source. Three distinct durable job rounds are seeded (39 jobs), never resetting
job IDs or old receipts. Data-only HTML extraction stays on the phone; it cannot
open Facebook. The remote synthetic adapter uses `test_listings`, not the full
Finder tables. Full actual Watcher/Finder persistence is verified separately by
`facebook-finder-full-schema.yml`; do not claim that this adapter proves the
production batch importer.

Remote initializer refuses the production project ref, a nonmatching DB host or
pooler user, transaction pooling, unverified TLS and any nonempty unmarked public
schema. It never executes DROP/TRUNCATE/reset. Restarts reload the same sources,
leases, receipts and offers from the marked DB. All test tables have RLS enabled
and all anon/authenticated/PUBLIC table access revoked. The Python bridge binds
only 127.0.0.1 and exposes no arbitrary SQL. Initialization interrupted before
its marker is committed fails closed and needs operator review.

API opt-in: `FLIP_OFFLINE_REMOTE_TEST=true`; default is off. `FLIP_ISOLATED_TESTS`
is set only inside the dedicated image. Do not run it as a production Next route.
Configure the NEW test project reference/session-pooler URL, HTTPS API origin,
SHA-256 signing key derived from a freshly random 32-byte device token, and an
expiry no later than seven days. Credentials stay in the hosting secret store.
No standard production Supabase/OpenAI keys are accepted. The shared CI key is
rejected in remote mode. No request bodies, HMAC headers, tokens or leases are
logged. All `/__test/*` control endpoints return 404 remotely.

Public `/healthz` exposes only health and OFFLINE_TEST mode. External TLS is
terminated by Render; the internal listener requires the configured Host and
`X-Forwarded-Proto: https`. Signed source/job endpoints use the existing exact-body
HMAC protocol and persistent unique nonces; used nonces expire after 10 minutes,
longer than the signature validity. HTTP connection/body/time limits are bounded.
There is one authorized test-device identity; this is not a multi-user service.

Both `LIVE_COLLECTION_ENABLED` and `ANDROID_BACKEND_INTEGRATION_ENABLED` remain
false in APK. Production queue/integration flags stay false on the test host.
The optional transactional Finder draft is NOT installed in the synthetic remote
adapter; never enable it against production as a side effect of this test.

## Operator steps after explicit approval

1. Verify Free organization/project quota and hosting account; no billing change.
2. Create a separate Free Supabase project; supply only its session-pooler URL
   (port 5432; verified TLS). Never copy production rows, filters or cron jobs.
3. Create NEW Render Free service from the reviewed blueprint; auto-deploy off.
   Set the exact assigned HTTPS origin and secrets without putting them in logs.
4. Generate a fresh 32-byte base64url device token privately. Store only its
   SHA-256 hex as `FLIP_OFFLINE_DEVICE_SIGNING_KEY` on the server. Set the same
   epoch-millisecond expiry on server and private phone profile.
5. Wait for `/healthz`, verify RLS/nonce/fixture-control denial, and verify restart
   preservation on this actual Free infrastructure. CI does not prove its TLS,
   permissions, quotas or availability.
6. Dispatch APK workflow on the integration branch with `offline_test_origin`
   equal to the approved test origin. Input is public configuration, not a token.
   APK default has an empty origin and remote testing disabled.
7. Deliver the private profile to the user through an approved private channel:
   `{version:1,dataMode:"OFFLINE_TEST",origin,deviceId,deviceToken,expiresAt}`.
   Do not publish a profile/QR in GitHub artifacts, comments or CI logs. Clear
   the clipboard after pasting. Phone stores the profile with Keystore encryption.
8. Install the validated integration APK beside production. If an existing
   integration APK has a different debug signing certificate, STOP and preserve
   its data; do not uninstall or clear data to force installation.

## Samsung-only acceptance steps (no Docker/ADB/computer)

Open the service health URL in the phone browser first if it has gone to sleep;
allow about one minute for the Free host to wake. In Flip Collector (offline
integration), paste the private test profile into the masked configuration field
and choose “Sparuj testowy telefon”. Set a currently allowed schedule window;
keep Wi-Fi, charging, battery >=20% and temperature below the safety threshold.

Run “Cykl offline”. Confirm 13 sources, 11 groups/2 profiles, unavailable profile,
last-sync/device/queue status, per-source results and encrypted outbox draining.
Disable one local source before a fresh round. Interrupt Wi-Fi during a run,
restore it and retry; restart the app and check that completed sources are not
repeated in the same window. Source error must not prevent subsequent sources.
Test stop and continuation within the same allowed window. Do not turn on LIVE.

The 8-minute budget includes synchronization/recovery, retains a 35-second
commit reserve, and uses one WebView at a time. The existing WorkManager
continuation resumes unfinished eligible sources only inside the allowed window.
A provider cold start/timeouts consumes that budget; retries retain the exact
pending completion body and use fresh HMAC nonces. The fixture has three durable
rounds; an operator must explicitly enqueue more synthetic jobs when exhausted.

## Retention, rollback and actual LIVE prerequisites

No automatic destructive retention is enabled. Keep pending outbox/receipts until
reconciled; Android's 500-receipt guard fails closed. This seven-day/39-job fixture
is bounded. Nonces older than ten minutes are deleted after signature expiry.
On expiration, stop accepting signed work; preserve DB/outbox for reconciliation.

Rollback: disconnect fixture on the phone (state retained), stop the NEW test
web service and revoke its test credential. Retain/export synthetic receipts if
needed. Deleting the NEW database is a separate irreversible operation, not
performed by startup or rollback code. Production flags remain false throughout.

Before a real scan: review the now CI-verified versioned whole-batch recovery
and retention policy, validate the schema/drafts on approved staging, review per-device
source grants, approve backend deployment separately, then obtain explicit user
consent for the Facebook session and one real group. A new separately reviewed
build/activation is required for LIVE. Physical Samsung Android 16 background,
Doze/locked-screen behavior and real Facebook HTML are not certified by fixtures.

## Verified checkpoint

All six CI workflows passed for remote commit `646f91dfe0676d70dba24e73786e7d50a7d1dd32`.
See [validation and APK report](facebook-android-0.7-validation.md). This does not
constitute provider deployment or a Samsung test. The default APK has no approved
remote origin; building an origin-bound APK follows approval and provisioning.
