# Deal Room 2.0 — main integration / release gate

## Provenance and scope

Inspected 2026-10-16: main `642fdf3301d08cd0151526625bd05ced3bc2fd43`; PR25→27→29→31→32→33→34 are open and form one dependency chain. PR34 remote `4a03e1d67b5dfb5c41dadadc7eb8a72ac804618b`, tree `e38adab5af84ea84484edf67e39d55ae2bc02d34`, equals preserved local `1d88a3b`. This branch starts from that complete tree; no manual cherry-picking or rebuilding of directors. New Integration Draft PR targets main, original seven drafts remain unchanged. No main/production mutation.

Finder already has direct Deal Room links on results, dialogs and opportunity-of-day. The existing canonical /deals/[listingId] view contains ten directors, Radar/general/district/city market hierarchy, renovation, cash/loan/investor CFO, conditional tax models, investor answers/CAS/receipts and CEO gates. This integration retains those mechanisms and adds an authorized synthetic test catalog directly above the main Finder, an unmistakable TEST label and paginated persisted analysis history. Clicking a normal listing continues its original route.

## Test account and isolation, default OFF

No actual investor UUID was supplied or discovered from production. Do not guess it or trust editable user_metadata/email. On a separately approved isolated instance, create/sign in to the intended test identity, grant existing `app_metadata.role=operator` through a trusted administrative process, and supply its verified Auth UUID in server-only `DEAL_ROOM_TEST_OPERATOR_IDS` (comma-separated UUIDs). An identity in the production Auth project is not automatically present in another Auth project.

Required server settings on that isolated deployment only:

```
DEAL_ROOM_TEST_ENABLED=true
DEAL_ROOM_TEST_OPERATOR_IDS=<verified isolated operator UUID>
DEAL_ROOM_TEST_DATABASE_ORIGIN=<exact isolated NEXT_PUBLIC_SUPABASE_URL origin>
DEAL_ROOM_QA_ENABLED=true
DEAL_ROOM_RADAR_ENABLED=true
DEAL_ROOM_CFO_ENABLED=true
DEAL_ROOM_TAX_REVIEW_ENABLED=true
DEAL_ROOM_TAX_ARITHMETIC_ENABLED=true
DEAL_ROOM_PRIVATE_TAX_ENABLED=true
DEAL_ROOM_JDG_TAX_ENABLED=true
```

Use only isolated NEXT_PUBLIC_SUPABASE_URL/publishable key and server-only service key. Gate refuses known production project `zmuisdirvfcxrvtbvrle`, production VERCEL_ENV, insecure remote HTTP, URL credentials/query/path and missing/mismatched origin, invalid/nonallowed actor or missing QA flag. Remote HTTPS and exact configured origin are allowed; operator must independently verify actual database/credentials separation, because a URL alone cannot prove ownership/isolation or detect a disguised reverse proxy. No production auth/schema/configuration was queried or altered.

GET /api/deal-room/test returns only actor-scoped catalog after existing getUser/operator verification. POST requires exact Origin and inserts three fixtures, no updates/deletes. Partial preparation can be retried; existing answers and original seed data are not overwritten. Errors return generic codes, no DB/credentials/answers in logs. Catalog IDs use reserved `deadbeef-` namespace, SHA256-derived per actor; all investment read/initialize/override/answers/history routes fence that namespace before DB access even when flags roll back. Real UUIDs are unaffected. These test IDs must never be used for real imports.

Fixtures: Łódź/Górna,45m²,2rooms, prices200000/340000/680000; inert example.test URLs, no photos, no source fetch. Three synthetic renovated asking-price comparables support explicit general fallback. Risk fixture uses existing human REJECTED veto; it does not claim automatic diagnosis of legal defects. No fake documents or verified legal/tax status. Radar remains real existing engine; its sufficient/insufficient samples are separately tested, not fabricated into a confident test valuation.

## Database preparation — future isolated environment only

Existing dependency schemas: Finder listings/snapshots/source metadata; market assumptions/resale comps; Investment OS phase1 `20260912120000`, foundation `20260912150000`, CAS `20260912180000`; Price Radar `20261008000000`; finally reviewed draft `supabase/drafts/deal-room-qa.sql`. Review full ordered migration history and dependencies against a clean isolated application database before application. Do not blindly run the entire historical migration chain against production or assume the minimal CI fixture is a production schema clone. No new migration is needed for this integration. Draft is intentionally not auto-applied, not idempotent; use migration tracking/manual review before future rollout.

QA SQL adds owner FK and service-only workspace/append-only receipt ledger; RLS enabled, PUBLIC/anon/authenticated grants revoked, security-invoker CAS RPC, service-role execution only. Service-role bypasses RLS, so API getUser/operator/owner checks and trusted actor binding are mandatory, not replaced by RLS. No user_metadata decisions. Existing SQL tests exercise roles/grants, rollback, ownership, concurrency/replay. No new public table/view/definer function. Admin key never NEXT_PUBLIC. No production advisor scan or migration applied.

History GET /api/flip-finder/listings/:id/investment/history requires existing owner, returns at most20 summary projections per page (not raw evidence URLs/answer documents), descending (created_at,request_id) cursor to avoid tied timestamp loss. History never rewrites old rounds; persisted latest state retains only previous/latest comparison, full immutable ledger is paginated on demand. Refresh history explicitly after saving answers. Retention remains manual: no destructive cleanup or irreversible deletion policy introduced. Before real deployment agree retention/export policy.

## Vercel / safety review

vercel.json and production settings unchanged. No deploy/merge/paid resource created. Existing cron in vercel.json must NOT execute in any future test deployment: require deployment-level scheduler isolation/disablement and outbound denylist, and keep all Watcher/LIVE/integration flags off. No production project linking/env pull. CI has dummy localhost credentials and disposable PostgreSQL/PostgREST, no deploy step or production secrets. Existing repository-wide Vercel Git integration may create previews outside this workflow; no preview was requested or assumed safe, and never open an unverified preview against production data. Approval must include host/database/auth/scheduler separation.

## Phone walkthrough after separate approval / deployment

No usable hosted URL exists from this code-only task. After operator approves and provisions the isolated web environment above (no paid service authorized), on Samsung open its HTTPS URL in Chrome, sign in with allowlisted test account, open Flip Finder. TEST banner→Prepare/resume→choose any synthetic card→Prepare analysis if requested. Existing ten-director Room opens. Answer CFO financing/equity/reserve/cost questions, save, reload, verify persisted response/history/CEO. Change renovation/price and verify dependent reanalysis. Unknown tax facts must remain UNKNOWN; do not enter fictional eligibility to make BUY appear. Repeat other two cards; known reject must remain reject. No APK/ADB needed: this is the existing responsive web app. Do not use production flip-manager-ai.vercel.app until separately approved release.

## Rollout and rollback plan — not executed

1. Review Integration PR and all seven components; confirm exact tree and final green CI, no Watcher/OLX diff.
2. Approve isolated host, database/auth/account and scheduler/outbound policy separately; validate real getUser/login→API→DB on mobile (current browser transport and API/DB suites are separate).
3. Apply reviewed schemas only on disposable database; enable server-only test flags there. Run synthetic phone acceptance and access-denial tests. No production token/cookie/session copying.
4. Production rollout is a separate approval: backup/schema review/grants/advisors, retention policy, monitored activation, no auto tax decisions. No automatic BUY or tax filing.
5. Rollback: disable TEST and feature flags first; test namespace remains denied; owner checks survive QA-off; redeploy previous approved application if necessary after approval. Keep receipts/owner columns/ledger, never drop data to roll back. Revert migrations only through reviewed lossless plan; do not remove ownership protections while returning older code.

## Known limits

Tax remains conditionally modelled, actual liability UNKNOWN; bounded 2026 PRIVATE/JDG-linear cases, externally qualified JDG contribution schedule, no universal ZUS, unsupported tax forms/VAT/annual activity/SP_ZOO UNKNOWN. Post-tax Max Buy/stress UNKNOWN. No accountant/legal certification, physical phone or real authenticated hosted browser→DB test yet. No authorized account bound or hosted environment activated. Full production schema compatibility/runtime Vercel configuration not asserted without access/approval. All prior tax/readiness limits in docs/deal-room-jdg-audit.md apply.

## Verification checkpoint

Integration Draft PR: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/35, base main. Final code verified in [CI38922124037](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38922124037), remote runtime `1a2a809041ce2e6dbab559534cfe48df56ec1821`, local runtime `22340ad`, tree `f98d799300f1da3e6d84145166207117b6e00c1d`. All3 jobs SUCCESS.

| Check | Actual result |
|---|---|
| Full TypeScript / full Next.js build | PASS / PASS |
| Scoped Deal Room + changed app/API ESLint | PASS,0errors,2pre-existingwarnings |
| Node directors/finance/taxes/Q&A/security | 160/160 |
| Existing MARKET/Radar | 97/97 |
| PostgreSQL CAS/roles/replay/ownership/rollback | 8/8 |
| Actual API→services→PostgREST→PostgreSQL composites | 3/3 |
| Mobile browser (new Finder TEST + Q&A/history, existing regression) | 4/4 |
| Independent Decimal rule / PRIVATE / JDG algebra vectors | 80/80,12/12,4/4 |

Do not add local22 pure/config tests again to160, or local97 MARKET to CI97. The Decimal vectors verify independent arithmetic, not statutory contribution qualification. Mobile viewport390×844 tested by Playwright Chromium, not physical Samsung. Browser uses fake Auth + mocked API transport; real API/DB composites mock only identity/admin factory and use real isolated PostgreSQL/PostgREST. A single real authenticated browser→DB hosted flow has NOT been run. Repository-wide ESLint outside the integration surface has NOT been claimed.

The three existing Radar-backed API cases reproduced operating pre-tax profits150732.50 /7932.50 /−338867.50 PLN and CEO HOLD/HOLD/ODRZUĆ. New TEST composite verifies repeated preparation preserves saved answers, rejects wrong actor/production/Origin and reads22 receipts across pages with21 tied timestamps without loss/duplication. Existing composites retain missing-Radar/general/district/city fallback, stale/source/owner fences, recoverable response loss and all PRIVATE/JDG withdrawal/reanalysis coverage. New phone UI catalog has three actor-scoped links and no horizontal overflow.

Earlier integration runs38921739832 and38921929125 failed fixture/type checks (duplicated fields/column and ProcessEnv weak-type mismatch). Those were fixed through explicit keys, no assertions/looser null handling; final run above passes every step. Local clean diff check and high-confidence private-key/GitHub/OpenAI/JWT pattern scan of all68 changed tracked files found no matches; this is not an exhaustive credential audit. Protected Watcher/collector/workers/extensions/android/vercel.json diff vs main is empty. No remote production/advisor/configuration inspection or mutation was performed.

## Stop / resume checkpoint

Code integration and isolated CI complete; stop before merge/deployment/activation as instructed. Final follow-up commit changes documentation only, with skip-ci; tested runtime remains the SHA above. Original seven drafts/branches preserved; local original history preserved, published trees matched exactly via Git Data API. Main remains642fdf3. No paid service provisioned; existing GitHub Actions quota/billing was not inspected or altered.

Ready for reviewed code acceptance and future controlled synthetic user testing AFTER separately approved isolation/deployment/account binding. Not currently reachable on the user's phone: no test host deployed, account UUID not configured, migrations not applied outside CI. No production/tax-decision readiness claim.

Resume only after user's explicit deployment authorization: inspect PR35 and this checkpoint, reconfirm main/head/green run; confirm isolated host/database/Auth UUID/schedulers/outbound boundaries and free-resource budget; then execute the reviewed isolated setup and phone walkthrough above. Do not repeat completed implementation/CI without new code or failures. Production rollout/merge/real investment decisions require their own approval; never infer permission from test-host approval.
