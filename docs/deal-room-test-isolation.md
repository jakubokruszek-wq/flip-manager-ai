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

Current implementation pending fresh CI. Prior PR35 run38922124037 tested the SUPERSEDED separate-database/normal-table seed, not this rewrite. It is not evidence that this revised storage is safe. Fresh unit/director, full build/TypeScript/scoped lint, PostgreSQL17 SQL/CAS/security, API/DB denied-real-traffic and mobile suites must pass before final report. Hosted authenticated browser→DB on Samsung is still a future controlled acceptance step; no production test writes performed here.
