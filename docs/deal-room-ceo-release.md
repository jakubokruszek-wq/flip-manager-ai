# Real Deal Room CEO / retirement of user-facing TEST

Base main c9aec9c74aea571f6f0bd7e218d221c1ec187eda (PR35 merged by user + golden Q&A style). Main tree a2b5333f20ad9caa3e90c5cb1ac136e6c10985aa verified against local baseline e323d77. Branch feat/deal-room-ceo-recommendation. No merge/deployment/configuration/data mutation authorized.

## One coherent application change

Finder has no TEST panel, prepare/resume button or virtual apartments. All /api/deal-room/test routes removed (404), /deals/deadbeef-* returns notFound before any investment API/DB access. Normal investment endpoints keep rejecting legacy synthetic IDs. Production modules no longer read DEAL_ROOM_TEST_* or import fixture modules. Old runtime seed/store code moved into test-fixtures/retired-demo for retained CI-only isolation/CAS/replay/roles tests, not registered as application routes. Fixture-only immutable feature switches removed from the production feature module. No legacy TEST data is copied into real listings/deals/comparables.

Real Deal Room remains one canonical engine/Brain, existing Q&A/CAS/history and existing ten directors. New first-screen "Końcowa rekomendacja CEO" projects BUY/NEGOTIATE/VERIFY/WAIT/REJECT as KUP/NEGOCJUJ/HOLD/ODRZUĆ; never derives a separate decision from profit. Existing Brain BUY path additionally fails closed on missing gates, failed VERIFY/UNDERWRITER validation or indicative market evidence. Human reject remains absolute. No tax model or tax activation flag changed.

Max Buy reads the canonical underwriting limit, or its existing selected CFO maxBuy when financing is active; if financing selection/validation is missing it stays NIEUSTALONE, no stale CEO fallback. Negotiation reads the canonical openingOffer only for an existing NEGOTIATE, validated finance and a positive offer within canonical Max Buy. No price formula added. PLN display preserves canonical cents. Low/base/high profits are the SAME operating underwriting scenarios; pre-tax, and when CFO is active explicitly before financing and investor split. They never masquerade as owner net profit. CFO remains the source for its own cash/finance/tax result; unknown actual tax remains unknown.

Conditions use existing critical gates, prioritized Brain questions and unresolved CFO fields: what/why/requesting directors/evidence/status. Missing/unverified is NIEUSTALONY, not a fabricated confirmed defect; known funding shortfall/material conflict/price breach can be NIESPEŁNIONY. Passed gates SPEŁNIONY. Existing pending Q&A links expand questions and focus the matching field; no auto-answer or submission. After a real answer, existing canonical reanalysis/onAnalyzed updates CFO, CEO and history. Risks are existing director/conflict findings, severity-sorted, maximum5. One next action comes from current Brain. Details collapsed; gold question styling from main preserved. No autonomous AI claim, purchase or paid API.

## TEST deactivation / cleanup plan — REVIEW ONLY, not executed

1. After user approval, inventory Vercel Production/Preview/Development scopes WITHOUT logging values. Remove or set false DEAL_ROOM_TEST_ENABLED; remove DEAL_ROOM_TEST_STORAGE_VERSION and DEAL_ROOM_TEST_OPERATOR_IDS. Existing Watcher/OLX/cron/filter/tax flags unchanged. New code ignores obsolete TEST flags, so absence of config access cannot revive demos.
2. Approve merge/application deployment separately. Validate Finder lacks TEST, legacy catalog/case/answers/history/initialize URLs return404, virtual page404, real listings/Q&A/history unchanged. Existing Git→Vercel preview automation is not production rollout approval; no preview DB rebind requested.
3. With separately approved DBA access, READ ONLY preflight: existence/row counts/owner distribution/size of public.deal_room_test_cases and public.deal_room_test_rounds, current FKs/grants and active application references. No real user offer/history rows need inspection or cleanup. Do not run old TEST creation drafts as part of retirement.
4. Freeze TEST writes if necessary using reviewed TEST-only permission revocation (existing supabase/drafts/deal-room-test-rollback.sql); this retains data. Tables may be absent — stop rather than creating them. Do not change grants/columns/RLS of real deals or Q&A tables.
5. Export ONLY those two tables into restricted backup storage including schema, owner/case/request IDs, versions, JSON state/receipts and timestamps. Validate checksum, counts, parent/child consistency and restoration into disposable PostgreSQL. Backups contain investor answers; no public ZIP/PR/log upload. Agree retention/deletion scope with user before proceeding.
6. ONLY after separate explicit data-deletion approval, reviewed transaction deletes approved TEST receipt rows first and matching TEST case rows second, only in those two fully qualified tables. Verify counts within the same transaction, rollback on mismatch; commit only approved scope. No TRUNCATE CASCADE, no broad name matching, no DELETE from listings/deals/Radar/QA, no DROP tables/functions/schema. No deletion SQL executed or automatically shipped by this PR.
7. Retain empty tables/functions inaccessible and exported backup for agreed retention. Any future DROP requires another separate approval. No arbitrary retention period chosen here.

## Lossless rollback

If CEO presentation fails, revert this application PR to the reviewed prior release but KEEP all three TEST flags disabled, keep deprecated endpoints inaccessible and preserve legacy-ID fences. Do not reactivate the retired demo. New change adds no schema migration. Keep real listings/deals/Q&A/history and TEST rows untouched. If TEST-only permissions were revoked, restore them only after separate review (normally no reason to reactivate). If a later separately approved deletion occurred, restore only exported TEST tables in dependency order after validation; never overwrite real data.

## Acceptance / limits

No production database/Vercel mutation, no tax logic changes, no Watcher/OLX/scanning/cron/filter/Radar-source changes. Existing actual data/history preserved. Synthetic scenarios exist only inside automated fixtures, not Finder. A BUY regression uses an explicitly fully validated canonical fixture; answering a legal narrative does not promote it to verified evidence or promise BUY in a real case. Professional document verification remains required. Browser transport and actual API/DB suites remain distinct; a physical Samsung production test requires separate approved deployment.

## Checkpoint

Implementation in progress. Full fresh CI required: TypeScript, full ESLint, build, rule/director BUY/HOLD/NEGOTIATE/REJECT/veto/unknown/cents projections, Q&A/history, PG, retired-demo denial/isolation, MARKET/Radar/Finder and 390px mobile screenshots. No PASS inferred from PR35. Resume from current branch and failing job only; no production activation/deletion authorized. Final evidence will replace this section.
