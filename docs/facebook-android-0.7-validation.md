# Facebook Watcher 0.7 — verified checkpoint (2026-10-15)

## Code identity and preservation

Verified local code commit: `4d9810b1df8b03714ab72623cc6676aa6fffb8d1`.
Published code commit: `646f91dfe0676d70dba24e73786e7d50a7d1dd32`.
Identical Git tree: `f968e6e3ce6ac7643df28bfccec35fefa0588c3a`.
A subsequent documentation-only checkpoint does not change the tested code.
Draft PR: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/23 .
Original branches, commits and recovery ZIP were preserved. Original ZIP SHA-256
was rechecked unchanged: `1769bcec98466da2b7146ec7fc09c449539da29225a36dbe72e74aff6165c837`.

Local/published 0.7 checkpoints (Git Data API preserves exact final trees):

| Local commit | Published commit |
|---|---|
| 60f6a27e20f21963d72636b2bb655c249aa60e0b | 3fe304538412dea1c131038363925ab40bf031fd |
| a593f70b4d9a99e76dabe36a7d0b5426b59b5ef2 | d0a7f6c19bb8a48337a568cd88af1efcd37f66e7 |
| 21445da46b93b48b8f8417480dba4cf58427787b | 1e9b9561976d1ab7d6925739f344c0701b5dc784 |
| 0ba8a0d31587f395a3cea0c5251a4f106f80d7dc | c870276fb2400c907cf4c2da14971cf1b181d2de |
| 9f949a50c315d702a0622b0e02a43889d9f9eb4a | e7dd90afed3d49c41401c8fe30f6b2ef65974043 |
| 37b45897e077fba04499367e0627139275066837 | ae3e54d47f4796c560b29403ad321470f3baec5f |
| 4d9810b1df8b03714ab72623cc6676aa6fffb8d1 | 646f91dfe0676d70dba24e73786e7d50a7d1dd32 |

## Completed CI evidence

These are completed runs on the published code commit, not inferred from older runs.

| Scope | Result | Evidence |
|---|---|---|
| TypeScript, ESLint, complete Next.js build | PASS | [isolated validation](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769848263) |
| Node unit/security/regression/offline simulation | 398 PASS: 90 backend + 65 offline/core + 243 regression | same validation run |
| Queue SQL, concurrency, lease and permissions | 16 PASS, real PostgreSQL 16 | same validation run, postgres job |
| Full public application schema and actual Watcher/Finder importer | 12 PASS | [full-schema run](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769848157) |
| Remote-store identity/TLS configuration | 1 Python PASS | same full-schema run |
| Durable synthetic store restart/permissions/nonempty refusal | 2 Python PASS, real PostgreSQL | same full-schema run |
| Remote ingress HMAC/replay/checkpoint isolation | 1 Node PASS, local proxy simulation | same full-schema run |
| Kotlin/Compose compile, JVM, APK identity and assembly | 120 JVM PASS, zero errors/skips | [APK run](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769849362) |
| Standalone Android 16 instrumentation | PASS | [emulator run](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769848999) |
| Android 16 WebView → signed API → isolated PostgreSQL | 9/9 PASS | [system E2E](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769847841) |
| Container builds; refuses startup without explicit remote opt-in | PASS, no image deployment | [container run](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769847791) |

Local Node suites also passed. Local full builds/SQL/emulator were unavailable;
the CI runs above provide those results. Test groups overlap across workflows;
counts must not be added as unique tests across repeated runs.

## Real Finder and security scope

The isolated database restores 51 public application tables, 49 functions,
constraints, indexes, triggers, policies and grants from a schema-only snapshot.
Snapshot SHA-256: `3ee5b756be67b43e02809ba818e0f1e9417aef08e4ee60ceedebdd5bd4779069`.
No production rows, users, credentials or schedules were copied. Managed
Supabase Auth/Storage are not cloned; minimal auth interfaces are supplied for
schema restoration. PostgREST and the actual Supabase query builders/RPCs run
against disposable PostgreSQL. Only admin client construction and the localhost
Supabase gateway URL prefix are adapted, not importer persistence/normalization.

| Requirement | Evidence / boundary |
|---|---|
| Real normalization and sale qualification | Actual importer handles 260 tyś., rejects rental/buy, writes Finder membership/metadata/history |
| Concurrent INSERT/UPDATE/DUPLICATE | Per-post transaction, advisory locks, unique constraints, operation witness; native race/update/no-op tests |
| Partial failure and recovery | Real post commit followed by dropped API response; exact signed retry after lease expiry recovers one receipt and accurate counters |
| Checkpoint and old owner fencing | Job/device/lease/completion/body hash/source grant; versioned reservation; legacy ambiguous reservations refuse automatic upgrade |
| Exact batch counters | Batch/source/device counters checkpoint with verified post receipt set; terminal batch disallows late new writes |
| Historical offers | Archived records not reactivated or repriced; unchanged retry adds no history |
| GROUP and PROFILE | Exact source-bound permalink validation, both tested; synthetic unavailable profile does not stop other sources |
| RLS/grants | Anonymous writes and service-only RPC invocation denied; managed-platform end-to-end auth is outside this clone |
| Other sources | Android refuses legacy cross-source portal mutation; no OLX job/control/schedule writes; unchanged legacy paths |
| Paid Vision | Request-local Android data-only extraction returns before Vision; dedicated regression test |
| Remote auth | Fresh per-device key, unchanged HMAC, nonce replay denied, no public fixture controls, HTTPS origin binding and expiring encrypted profile |
| Retention | No destructive automatic cleanup; bounded 39-job/7-day fixture; 500-receipt app guard fails closed; signed nonce expiry cleanup only |

The real Finder native suite and the Android system suite are separate layers.
Android E2E and the proposed remote phone server use synthetic `test_listings`;
they do not prove one combined Android → full Finder schema deployment. The
native suite separately proves signed API → actual Finder → PostgreSQL recovery.
No production import, real Facebook scan, session or Samsung test was performed.

## APK and installation

[Download APK artifact](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38769849362/artifacts/11990853146)
(ZIP containing `app-debug.apk`, GitHub login may be required).
Version `0.7.0-offline-debug`, versionCode 37.
Package `pl.jakubokruszek.flipcollector.integration` installs beside production.
APK SHA-256: `60c6a6c2c5a46426b4d5fda6a95da503bd001d3af51c63263e6299467d2c3acf`.
Artifact ZIP SHA-256: `b9d9aa9c0be79ba1cb0876178eaf1dd0c8ea6eb0667cc1c3f9c976985ca6e987`.
Artifact retention currently ends 2026-11-14; download before expiration.

On Samsung: download/unzip, open APK and allow installation for that download
source if prompted. Never uninstall an existing installation or erase its data
to resolve a signing conflict. CI debug signing-key continuity and actual Samsung
upgrade compatibility are unverified. This APK has no remote origin configured;
it cannot yet connect to a deployed phone test environment. Both LIVE and
production backend integration build flags remain false.

## Remaining work and deployment boundary

No new service was provisioned and no deployment was performed. Additional
service cost incurred: zero; account-wide CI/free quota availability is not a
billing audit. A seven-day Render Free + NEW Supabase Free proposal, guarded
bootstrap and manual pairing flow are ready in
[remote-test plan](facebook-android-0.7-remote-test.md). User approval for remote
deployment remains pending; the resume instruction preserves the deployment ban.
After separate approval, verify free account/project capacity, provision only
new isolated resources, configure private expiring test credential, run the
remote health/TLS/cold-start checks, build an origin-bound APK and validate it on
Samsung without Docker/ADB. No paid fallback or automatic plan upgrade.

Still unexecuted: actual provider deployment and quotas, phone pairing/network
loss/restart, physical Samsung locked-screen/Doze/background/thermal behavior,
managed Supabase Auth/Storage integration, one combined phone/full-Finder staging
flow, and every real Facebook/LIVE test. Synthetic source priority and timing
are tested; production source effectiveness rankings have not been measured by
new scans. Legacy version-0 ambiguous imports need manual reconciliation.
Deterministic import failures may remain fenced until operator repair; never
clear reservations or delete receipts merely to force progress.

Before the first controlled LIVE scan: separately approve staging/deployment
and SQL review, reconcile any legacy jobs, set device-specific source grants,
agree receipt retention/reconciliation, test Samsung scheduling on the remote
synthetic service, then separately approve a Facebook session and ONE real group.
A reviewed LIVE-capable build and explicit activation are required; this offline
APK cannot enable LIVE. No CAPTCHA bypass or stored Facebook session is allowed.

Rollback: keep all new flags off; disconnect test client while retaining outbox,
stop the new service and revoke its test credential. Preserve receipts for
reconciliation; do not delete a database or pending outbox as an automatic
rollback. No main merge, production migration, deployment, OLX/Cloudflare change
or paid service was performed.
