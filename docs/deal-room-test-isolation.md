# PR35 — TEST in the existing Flip Manager / existing Supabase

Supersedes the separate-database TEST plan in the first PR35 revision. Architecture approved by user comment6218932937, not deployment approval. No activation, production DDL, data write, merge or paid service authorized/executed.

## Isolation correction

Removed all TEST insertion into listings/resale_comps. Virtual records and comparables exist only as pure fixture input to the original buildCanonicalDeal/buildDealBrain, not in Finder/Radar/collector datasets. New public.deal_room_test_cases and public.deal_room_test_rounds are separate server-only owner-scoped TEST stores. Only Auth UID FK; no dependency on real deals, listings, comps, intelligence, gallery, price history, scanner or alert tables. No user triggers. No scheduled task, source fetch, AI/paid request or external image. Inert example.test URLs; no source identity promoted to EXACT. Fixed synthetic October2026 scenario clock explicitly not current market evidence.

Every endpoint authenticates existing getUser/operator first, checks server UID allowlist and TEST switches, then validates actor-derived case ID BEFORE DB/replay/calculation. UUID is never accepted as actor from client. A server service key bypasses RLS: that is why these gateway checks are mandatory. Tables have FORCE RLS and no browser grants/policies; only service role access, receipts append-only (no UPDATE/DELETE grants). RPC is SECURITY INVOKER, public/anon/authenticated execute revoked. State+receipt commit is atomic, row-lock/CAS; same request/hash replays before stale version validation, changed payload conflicts, cross-owner cannot replay. No TTL/destructive retention. FK restrict prevents accidental erasure on Auth deletion; retention/account deletion needs separately reviewed export/cleanup.

Routes are /api/deal-room/test and /api/deal-room/test/:case[/initialize|/answers|/history]. Existing normal investment paths unconditionally reject reserved deadbeef- TEST IDs even with TEST enabled and real QA disabled. API responses private/no-store, mutations exact-Origin, JSON/24KB strict answer validation. Raw DB/auth/answer errors are not logged. No fallback to normal persistence when TEST schema is absent. Missing contract/migration returns503 TEST_STORAGE_UNAVAILABLE, wrong account/switch/storage-version returns404. No real global QA/CFO/tax flags need activation: internal immutable request context enables existing pure modules only for TEST, with original environment-based defaults preserved elsewhere. Global process.env is never temporarily mutated by server requests.

CEO TEST policy always retains HOLD/REJECT and never BUY; unknown tax qualification/net remains UNKNOWN. Known risk fixture has human reject veto, not automated legal diagnosis. No after-tax Max Buy/stress or statutory ZUS certification. Existing CFO/tax limits from earlier docs apply.

## Actual production schema read-only review, 2026-10-16

Read only information_schema columns, pg_class/pg_trigger metadata and migration list; no listing values, accounts, sessions, tokens or production data copied. Observed PostgreSQL17.6. Existing deals has version/source_updated_at but NO deal_room_owner_id; real deal_room_workspaces absent. New test cases/rounds absent. Existing listings/deals/deal_fact_overrides each have one user trigger; listings/resale_comps/deals/overrides/price_radar_listings RLS enabled. This is why TEST must never seed those tables. auth.uid() and service_role exist.

Historical dependencies inspected: Finder foundation20260719113000, resale comps20260905120000, Investment OS20260912120000/150000/180000, Radar20261008000000. New TEST SQL depends only on existing auth.users(id), roles, public schema, JSON/UUID/PLpgSQL; it does NOT depend on uninstalled deal-room-qa.sql or alter real tables. The real QA migration remains a separate rollout question; do not bundle its execution into TEST activation. No production advisors or full schema/data clone claimed.

## Review-only artifacts, not automatic migrations

- supabase/drafts/deal-room-test-storage.sql: atomic new-store DDL/grants/functions. Not an automatically applied migration or idempotent script. Name conflicts must stop deployment; do not use CREATE OR REPLACE against unreviewed existing objects.
- supabase/drafts/deal-room-test-preflight.sql: read-only namespace/role/Auth/ownership/grant/trigger checks. Owner UUID setting must come from verified existing account, never guessed; the script returns only boolean eligibility. At present no investor UID was supplied or bound.
- supabase/drafts/deal-room-test-rollback.sql: flag-off plus revoke TEST writes/execution; retain data/FKs, no real schema mutations.

## Exact one-time rollout, ONLY after user approval

1. Confirm PR35 final green SHA and review this diff/SQL. Confirm current main and planned merge; do not merge implicitly.
2. Verify actual existing investor Auth UID and trusted app_metadata.role=operator administratively. Never promote roles from client/user_metadata/email. User must approve exact configured UUID privately; do not put it in PR/docs/logs.
3. Keep DEAL_ROOM_TEST_ENABLED unset/false and existing QA/CFO/Radar/Watcher/OLX/cron settings UNCHANGED. No separate app/project, no preview rebind to production, no Watcher disablement. No new cost-bearing service.
4. Approved DBA performs preflight, backups current schema/new-store empty state, checks name collisions and auth dependency. Review SQL transaction in disposable PG17 first (CI). If preflight differs, STOP and review.
5. Only after explicit migration approval execute the new storage SQL ONCE using existing migration tracking/change process. Do NOT execute deal-room-qa.sql as part of this. Verify tables FORCE RLS/no client grants/no real-table FKs/no user triggers; RPC service-only/invoker; contract returns1 as server role. Apply no real table updates.
6. After separately approved application merge/deploy, set ONLY server flags DEAL_ROOM_TEST_STORAGE_VERSION=1, DEAL_ROOM_TEST_OPERATOR_IDS=<verified UUID>, DEAL_ROOM_TEST_ENABLED=true. No NEXT_PUBLIC secret/UID flags. Existing service-role key stays server-only; no key changes needed. These are two independent gates plus allowlist, not removal of old production guard: old seed path no longer exists; new storage contract must be present before code can persist anything.
7. Samsung Chrome: main application's existing login→Flip Finder→Deal Room2.0 TEST→prepare/resume→three virtual cards. Answer, save/reload, change renovation, check history/CEO; risk stays reject. Finance is simulation, not buy/tax advice. Verify another operator/unauthed account cannot reach catalog, case, Q&A, history or replay. Verify real Finder/Radar counts/report digests remain unchanged. No APK/ADB or Facebook login.
8. Keep change observation and rollback ready; no production investment activation or automatic decisions.

## Lossless rollback

Disable DEAL_ROOM_TEST_ENABLED first (all reads, saves, replay/calculations denied); leave real flags/Watcher/OLX/cron untouched. After approved DB change, execute TEST-only revoke script if emergency write freeze required. Retain test cases/rounds and Auth references; no deletion, no real data update. Do not roll back to the old unsafe seed implementation; any code rollback must keep TEST disabled and deny namespace. Re-enable only by separately reviewed grants/configuration. Record backup/checksum/version before any future retention cleanup.

## Verification / checkpoint

Final runtime verified: local `0ced74c`, remote `05231b8d0002147e3611975bb815ce4e646658cc`, tree `ce9e203e17c3dbf7ee992c580aa1124f502722de`. [Deal Room CI38928254069](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38928254069) all3 jobs SUCCESS. Existing [Price Radar CI38928253770](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38928253770) both jobs SUCCESS on the same runtime. Final follow-up changes documentation only, skip-ci; do not confuse earlier superseded PR35 green with this rewrite's evidence.

| Verification | Actual outcome |
|---|---|
| Full project TypeScript | PASS in both workflows |
| Full Next.js build | PASS in both workflows |
| Full repository ESLint (Radar workflow) | 0errors,24warnings |
| Scoped changed Deal Room/app/auth ESLint | 0errors,2existingwarnings |
| Node director/CFO/tax/Q&A tests | 161/161 |
| Trusted operator + all mutation-route/client-secret contracts | 12/12 |
| Existing MARKET/Radar module tests | 97/97 |
| PG17 real QA regressions + independent TEST SQL | 8/8 +9/9 |
| Real API/services/PostgREST/PG composites | 3/3 |
| Deal Room mobile browser | 5/5 |
| Additional existing Radar/shared adapter/scheduler tests | 493/493 |
| Additional existing Radar mobile browser | 4/4 |
| Independent rule / PRIVATE / JDG Decimal vectors | 80/80,12/12,4/4 |

Counts overlap between workflows/local subsets; no combined unique grand total claimed. Decimal vectors certify arithmetic under declared facts, not statutory ZUS eligibility or actual tax liability. Physical Samsung and one real authenticated hosted browser→API→current database flow NOT run; browser Auth/transport fixture and actual API/DB composites are separate suites. Do not activate a production test to fill that gap without approval.

The new API/DB composite runs as a verified-identity fixture against real PG17/PostgREST. During TEST it forbids EVERY DB/network route except dedicated test cases/rounds/contract/CAS. It compares complete real listing/snapshot/source metadata/deal/override/round/workspace/comparable/Radar/settings rows before/after: unchanged. Three virtual cases retain ten directors, indicative synthetic fallback, tax UNKNOWN/HOLD or known hard reject. Answer save survives lost response/replay/reprepare; stale/concurrent requests have one winner; other actors, disabled/missing switches, invalid/missing allowlist, missing schema RPC, wrong Origin and ordinary investment namespace are denied. History23 rows paginates20+3 with21 tied timestamps, no loss/duplicates; bad cursor400. Missing migration is fault-injected as actual PostgREST PGRST202/404 at the test fetch boundary; no fallback. SQL suite separately observes absent contract before creating it in an empty auth-only database with NO real listing/deal/QA schema, then runs preflight/contract successfully.

SQL checks prove RLS/FORCE RLS, browser/public denial, service-only invoker RPC, CAS/race/replay/owner/atomic rollback, BUY/missing identity rejection, only Auth/test-store FKs, no user triggers and lossless permission rollback with retained data. The migration/draft was applied ONLY to fixed localhost disposable CI PG17, never production. No production advisors/full data clone asserted.

Mobile new scenario enters existing main Finder→TEST catalog→virtual case→save/reload→history with real QA/CFO/tax flags OFF and ZERO ordinary investment API calls. Original Q&A/tax/director and Radar mobile regressions remain passing. [Screenshots](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38928254069/artifacts/12056714722), artifact SHA256 `6168a128c65553ad527adea2f71d2b048dc98eac0d9690b4e4a24dd31cda6f9c`.

Audit follow-ups: two old source-contract assertions assumed a hardcoded normal route; now check the shared router plus the exact unchanged real route behavior. New mobile receipt mock initially missed required invalidated metadata (real API was already correct); fixed without relaxing UI assertions. Broader auth audit found missing TEST/real-Q&A route classifications; registered them, with reviewed gateway auth-before-storage order. Origin remains ADDITIONAL CSRF validation after operator authorization, never an auth replacement. Source-action forgery checks preserved. Full route/client-secret contracts now included in CI.

## Final stop / approval checkpoint

PR35 remains DRAFT, base main642fdf3, no conflicts. Original stack preserved. No merge, production migration/data writes, manual/production deployment, feature activation, Watcher/OLX/cron changes, new paid service or preview database rebind. Repository Vercel integration can generate automatic PR previews; those are not main activation or proof of safe runtime configuration. We did not alter Vercel settings or request a deployment. Protected Watcher/collector/workers/extensions/android/vercel.json diff remains empty. No owner UID was guessed or installed. Pattern scan found no high-confidence private-key/GitHub/OpenAI secret matches in changed tracked code; not an exhaustive credential audit.

READY FOR REVIEW/APPROVAL of exact steps1–8 above. NOT activated or available as TEST in main yet. Remaining approvals/prerequisites: reviewed SQL/preflight and backup/change tracking; verified investor Auth UID/server allowlist; separately authorized merge/application deployment/TEST flags; real Samsung acceptance and runtime observation. Keep all current real module flags and Watcher/OLX settings unchanged. Existing Supabase storage/CI quota should be checked before activation; no new service or billing configuration was provisioned and no claim of unlimited free storage is made.

Resume from PR35 and this final runtime/checkpoint after explicit approval; do not repeat completed implementation/CI without new changes/failures. No credit-monitor or persistent auto-resume process is running.
