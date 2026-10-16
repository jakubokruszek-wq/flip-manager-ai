# Issue #30 checkpoint — P2b.1, not a completed tax calculator

Branch: `feat/deal-room-tax-scenarios`, worktree `/workspace/flip-deal-tax`.
Base: PR #29 / `feat/deal-room-cfo`, remote `fd5a820066799f10e13328dfb4a5d74512e8c34b`, identical local base `fd4bdb7`.
Draft PR #31: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/31
Initial code local `7b34a98`; remote `68cd927290a176ec63c9b9de7013a42f34674662` (tree equality verified by publication).

## Delivered scope

Issue #30 expressly permits P2b.1 when a trustworthy full tax model is not established. This PR implements that stage: explicit PRIVATE/JDG/SP_ZOO analytical scenario, calendar dates, activity/purpose, VAT, documented costs, other-income materiality, distribution and investor split basis, dated source/evidence questions. No JW/other-company model is invented. Answers retain kind, basis, actor, time, source fingerprint, document reference and NEEDS_EVIDENCE status through existing Q&A, CAS and immutable receipts.

`DEAL_ROOM_TAX_REVIEW_ENABLED` defaults OFF and also needs CFO enabled. Projection is in existing `underwriting.result.cfo.taxReview` JSON; no migration or role change. Existing P2a pre-tax cash, costs, scenarios, financing and stress remain authoritative. Post-tax cash-flow/ROI/Max Buy/break-even/stress and distributable profit are explicit null, not pre-tax values relabelled. `netProfit=null`, `taxStatus=UNKNOWN`, CEO stays HOLD. The selected form/answers cannot certify a tax rule or turn UNKNOWN into zero.

Three pure tests passed locally. Full isolated CI pending: build/TypeScript/lint, Node, PostgreSQL, real API/services/DB and extended mobile answer/reload. Do not claim remaining tests pass until checking the final run. Initial CI code published above; later fixes/checkpoint commits may follow.

## Audit: no double costs

P2a already pays inherited acquisition tax/PCC scenario, notarial/fixed purchase cost, purchase commission, gross renovation and contingency, holding, sale costs; adds declared finance fees/interest and outside equipment once. Loan/investor principal is not an expense. P2b.1 does NOT add PCC again, extract/deduct VAT from gross quotes, treat financing principal as deductible, subtract hypothetical PIT/CIT or distribute a guessed net profit. Existing profit-share remains explicitly pre-tax only until a reviewed contract defines tax/distribution order.

## Sources inspected 2026-10-16 — reference index, NOT approved law rules

Official MF pages were opened and inspected, not only search snippets:
- PIT private sale: https://www.podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-nieruchomosci — distinguishes the non-business condition; no automatic classification of a series of flips or residence relief.
- PIT business: https://www.podatki.gov.pl/podatki-firmowe/pit/stawki-i-limity — different taxation bases/forms; no automatic JDG scheme, threshold or contribution assumption.
- CIT: https://www.podatki.gov.pl/podatki-firmowe/cit/stawki-i-limity — links distinct classical and Estonian regimes. Cannot conflate company profit with personal distributable proceeds.
- VAT: https://www.podatki.gov.pl/podatki-firmowe/vat/stawki-i-limity — conditional rates; existence of a rate is not proof of its applicability or deduction rights to this property.
- PCC: https://www.podatki.gov.pl/podatki-osobiste/pcc/informacje-podstawowe — type of transaction, obligated party and tax basis require qualification, not an extra flat charge to an already-taxed model.

Several pages display update 15.12.2025; retrieval 2026-10-16 is not an effective date or certification. Search snippets and current page text can differ. No numeric rate, threshold, exemption or effective period is registered as executable. Source metadata version 1, accessedOn, effectiveFrom/To=null, professionallyReviewed=false, usableForCalculation=false. Reference older than 90 days (or invalid/future clock) flags refresh, but a fresh reference still never permits computation. Professional legal/transaction review has NOT occurred.

## Remaining work for complete P2b

Versioned official statute/consolidated text plus amendments and transaction-period applicability; accountant-reviewed eligibility, expense bases and VAT entitlement; JDG other-income/contribution effects; classical/Estonian company regime and withdrawal path; investor contract pre/post-tax split; payment dates/refunds and cash-flow timing. Only then implement separately gated numerical tax scenarios and independently verified amount/rounding/temporal tests. No claim the complete Issue #30 is finished by this P2b.1.

## Resume exactly once, without redoing prior stages

1. Read this file and `git status --short`, `git log -5 --oneline` in `/workspace/flip-deal-tax`; preserve all WIP and original branches/ZIP. No reset/clean.
2. Read PR #31 head and latest workflow for that SHA. Continue unfinished CI, fix actual failures; do not rerun completed passes without changed code or a failure.
3. Use `.github/workflows/deal-room-qa.yml`: all services disposable, synthetic localhost only. Publish fixes only to this branch; PR base remains `feat/deal-room-cfo`.
4. Update checkpoint and report accurate scope. Final docs-only commit may use [skip ci] after code passes. Do not conflate verified workflow with a verified tax algorithm.
5. For remaining numerical P2b, establish a small independently reviewable legal/model contract first. Do not guess missing rates or tax-free outcomes.

Ready resume prompt: “Wznów Issue #30 od docs/deal-room-30-progress.md na feat/deal-room-tax-scenarios / PR #31. Sprawdź ostatni checkpoint i CI bez powtarzania ukończonych etapów; zachowaj UNKNOWN przy niezweryfikowanym modelu. Bez produkcji, merge i deploymentu.”

No tool exposes Codex credit balance, renewal or persistent wake-up scheduling. No background ten-minute monitor was created. After a quota/session stop a user continuation is required; this file is the durable handoff. No paid service, production access, live collection, deployment command or changes to Watcher/OLX/Cloudflare/Render. Repository auto-preview was not used with real data.

## Final P2b.1 checkpoint — verified 2026-10-16

No quota exhaustion was observed; no quota monitor/wake-up API exists in this toolset. Stage P2b.1 is implemented and tested. Full numerical P2b remains explicitly incomplete for the qualification/source/model reasons above.

Tested code local `7b34a98`, remote `68cd927290a176ec63c9b9de7013a42f34674662`, tree `e8814280fc7fdd3a40beeee40f5a996b8e327e4e`. Final follow-up commits contain only this Markdown checkpoint; runtime code unchanged.

[Final CI](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38875187522): all three jobs SUCCESS.
- TypeScript, scoped ESLint, full Next.js build PASS. Existing two lint warnings remain, zero lint errors.
- 136/136 Node PASS, including three new UNKNOWN/source-date/calendar/dependency tests. No numerical-tax correctness claim: no tax algorithm is enabled or implemented.
- 8/8 PostgreSQL owner/CAS/retry/rollback/RLS/grant regressions PASS.
- Actual API → Investment OS services → Supabase/PostgREST → isolated PostgreSQL composite PASS, including tax scenario/date answer, immutable replay and persisted reload, updated CEO, UNKNOWN/null net profit. Existing P2a and MARKET hierarchy remain passing.
- 4/4 browser regressions PASS. Extended mobile flow saves JDG scenario, recalculates, reloads tax panel, verifies UNKNOWN/HOLD and no horizontal overflow. Existing Brain, Premium Deal Room and Finder checks pass.
- Local existing market/Radar regression rerun: 97/97 PASS; new pure tests 3/3 PASS locally as well.
- Loaded Node coverage: 79.23% lines / 83.06% branches / 82.21% functions, not whole-repository coverage or coverage of the separate native service test.
- [Mobile screenshot artifact](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38875187522/artifacts/12035201488), SHA-256 `68712b06af0d68a218ae7a86efafa0b0751596f1b0ca50590c95d67d9e2a31f3`.

Verification boundary: browser API/auth transport is mocked; the actual database path is a separate native API test. No physical Samsung, live production or tax-filing test was performed. No claim about actual tax owed or available withdrawals. All new functionality is off by default.

### Independent synthetic phone test, without production access

Use only an independently verified isolated environment with the existing Q&A draft/fixtures and synthetic operator. Do not use repository Vercel preview until its secrets/DB isolation are confirmed. Enable QA, CFO and TAX_REVIEW flags only in that isolated environment; no flag is changed by this PR. Open synthetic deal, supply P2a fields (cash/equity/reserve/deposit/gross renovation scope) and save. Open investor questions, choose PRIVATE/JDG/SP_ZOO as an analytical label, supply synthetic dates, save, reload, compare round/CEO and financial panel. Expected: saved declarations/history, next ≤5 tax questions, all three post-tax/distribution amounts UNKNOWN, pre-tax P2a numbers retained, CEO HOLD. Withdraw a date; it becomes missing again. Switching flags off and explicit refresh removes the new projection without deleting answers/receipts. Do not enter names, identifiers, real contracts, bank data, tokens or session cookies.

### Next implementation checkpoint

Continue from PR #31 HEAD (confirm SHA via Git, do not hardcode a stale documentation-commit SHA). Do not rerun the successful code suite for docs-only updates. Next deliverable is a small reviewed legal/model contract: explicit tax regime, property/activity qualification, dated statutory provisions/amendments and applicability, VAT entitlement and gross/net bases, income and withdrawal allocation, payment schedule and independent numeric test vectors. PRIVATE/JDG/SP_ZOO estimates must remain UNKNOWN until their selected contract is complete; unsupported forms remain unmodelled. No automatic tax-free private sale, threshold selection or deduction. No merges/deployments/migrations/production actions are authorized.

## P2b.2 in progress — 2026-10-16

New worktree `/workspace/flip-deal-tax-model`, branch `feat/deal-room-tax-model`, based on clean PR #31 tree `b5d05400a65d0c8cc4c86230081f9bb327ac3f65`. Original PRs/worktrees and ZIP preserved. Source/calculation contract committed as `8bcf53b`; see `docs/deal-room-30-p2b2-model.md` for current Sejm texts, replaced VAT consolidation, known dates, applicability gaps and independent numeric vectors.

Implemented bounded conditional arithmetic for explicit PRIVATE PIT19, JDG linear PIT19, classical company CIT19, separate natural-person dividend PIT19, alternative PCC2/PCC6, invoice gross VAT23/VAT8. New `DEAL_ROOM_TAX_ARITHMETIC_ENABLED` OFF, additionally requires existing CFO/TAX_REVIEW projection. Typed rule/base answers use existing immutable Q&A/CAS/receipt and invalidate dependent CEO. Scenario mismatch/unsupported input -> no arithmetic. Integer cents, full-PLN base/tax rounding, no implicit exemption, no tax deduction or cost mutation. Actual liabilities and all after-tax project outputs remain UNKNOWN because a full effective-period/qualification model is not yet verified. This is not a completed P2b.2 tax-liability engine.

Local pure tests 8/8 PASS. Full TypeScript/lint/build/Node/PG/API/mobile tests pending on the new PR. Added native API checks for arithmetic answer persistence/replay, CEO fingerprint, withdrawal and no manufactured net profit. Do not claim these pending checks PASS yet.

Resume: inspect clean/WIP status in the new worktree; check new stacked PR CI before rerunning anything; fix actual failures. Then continue the amendment/transition and transaction eligibility audit, define evidence-qualified bases, VAT entitlement, contributions and payout timing. Do not release automatic net cash/ROI/Max Buy while UNKNOWN. No credit monitor or persistent wake-up is available.

## P2b.2 checkpoint — tested bounded stage, full tax model NOT complete

Draft PR #32: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/32, stacked base `feat/deal-room-tax-scenarios` / #31. Worktree `/workspace/flip-deal-tax-model`, branch `feat/deal-room-tax-model`.

Runtime code tested: local `dad6196`, remote `f7a8f45f726b92c220df2e761820310fd09d5a90`, exact tree `2029af0c130aed96283e7df349904a85a685d96e`. Subsequent changes are Markdown only [skip ci]; original local commits preserved and each Git Data API publication checked against the local tree.

[CI run 38887999924](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38887999924), all 3 jobs SUCCESS:
- Full TypeScript and Next.js build PASS; scoped Deal Room ESLint PASS, 0 errors / 2 existing warnings.
- 142/142 Node PASS (includes 8 pure tax tests and CFO answer/dependency regression).
- Independent Python Decimal oracle: 80/80 vectors PASS, in CI and locally. This is arithmetic verification, not tax qualification.
- 8/8 isolated PostgreSQL CAS/owner/replay/rollback/RLS/grants PASS.
- Native API → services → PostgREST → isolated PostgreSQL composite 1/1 PASS, including conditional basis answer, persistence, immutable replay, changed CEO and withdrawal removing arithmetic. No fabricated net profit.
- 4/4 browser regressions PASS. Extended mobile Q&A supplies tax facts, JDG linear rule and separate basis, saves/reloads conditional 19000 PLN, checks unchanged cash ledger / UNKNOWN net / HOLD / no overflow. Browser auth/API transport is mocked; actual database flow is tested separately, not one authenticated browser-to-DB test.
- Existing local market/Radar regressions: 97/97 PASS.

First CI failed because the new API test redeclared `withdrawn`; fixed in local `8d05756` / remote `210b810ee91deeecc038477ba62a48a8c137cf5e`. The final run above verifies the fix. Intermediate superseded runs are not the basis for PASS claims.

### Exact remaining scope / no false completion

This delivery verifies explicit rate arithmetic and the existing answer/reanalysis flow. It DOES NOT complete the requested effective-period/eligibility model for real PRIVATE/JDG/SP_ZOO liabilities. No complete amendment/transition interval is certified; effectiveFrom/effectiveTo and actualLiability stay null. Classification of the particular flip, eligible income bases/costs, VAT rights/adjustments, contributions and solidarity, CIT9/Estonian conditions, lawful distributions/investor contracts and payment dates still need modelling and independent legal/numeric fixtures. Therefore net project profit, payout, post-tax cash-flow, ROI, Max Buy, break-even and stress remain UNKNOWN. No accountant/legal review is represented as performed.

No physical phone, actual tax return, production DB or live service test was performed. No migration/grant/schema change, deployment, merge, Watcher/OLX/Cloudflare/Render or paid service. All new flags OFF by default.

### Resume without repeating completed tests

“Wznów Issue #30 P2b.2 od docs/deal-room-30-progress.md na feat/deal-room-tax-model / Draft PR #32. Sprawdź aktualny HEAD i status, zachowaj wszystkie commity. Nie powtarzaj zielonego CI 38887999924 dla zmian Markdown. Kontynuuj brakujący model okresów obowiązywania i kwalifikacji według docs/deal-room-30-p2b2-model.md. Nie traktuj CONDITIONAL_ARITHMETIC jako zobowiązania. Najpierw zweryfikuj ustawowe warunki/podstawy i niezależne wzorce; dopiero potem połącz z cash-flow i przeliczaniem kandydatów Max Buy/stres. Bez zgadywania, produkcji, merge i deploymentu.”

The toolset still has no credit-balance/renewal API or persistent wake-up. No fictitious background monitor was started. No credit exhaustion was observed in this stage; this checkpoint records the actual incomplete boundary rather than claiming quota failure or a complete tax engine.

## Bounded PRIVATE transaction stage — in progress 2026-10-16

Worktree `/workspace/flip-deal-private-tax`, branch `feat/deal-room-private-tax`, base PR #32 remote `7e1b64addaa5e2882d03c05a9dd0d4e6949dfda2`, identical local base `956a591`. Original branches and ZIP preserved.

Contract: `docs/deal-room-private-tax-model.md`. Same-year ordinary private cash purchase/sale, explicit qualification and separately documented cost buckets; reviewed coverage 2026-04-01…2026-10-16, NOT asserted statute inception/expiry dates. No new rates. PCC reconciled by replacement, tax income differs from economic profit, owner capital distinct from profit, no dividend layer; estimated PIT payment and final cash/ROI reconcile. All prerequisite facts and reference mandatory. Missing/unsupported facts, dates, costs, business/VAT/loan/investor case => UNKNOWN. Actual factual qualification/liability still UNKNOWN; MODELLED_ESTIMATE is expressly conditional, CEO HOLD. JDG/SP_ZOO remain UNKNOWN with documented requirements. Post-tax Max Buy/changed-cost stress require fresh eligibility inputs and remain null.

Commits so far: `405a8e5` implementation/source contract; `5ca92cb` oracle/API tests. Local 14/14 pure tax tests and independent 12/12 full-model Decimal cases PASS; original 80-vector reference retained. Full CI pending. Mobile save/edit/reload and actual API/DB replay/withdraw extended; do not claim unexecuted tests PASS.

Resume by checking this worktree status and the new stacked PR CI before redoing tests. Fix actual failures; then update exact tested remote/tree and final report. New private-model flag defaults OFF; no production changes or feature activation. No credit monitor/wake-up API; this is a durable checkpoint, not an automatic quota-restart claim.

## Final checkpoint — bounded PRIVATE case, Draft PR #33

PR: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/33, stacked on #32 / `feat/deal-room-tax-model`. Branch `feat/deal-room-private-tax`, worktree `/workspace/flip-deal-private-tax`. Runtime tested local `b9617f4`, remote `1e3d94df4ee6408db0b967917b9718e0385190b4`, identical tree `f44ac61d7cc1fd744c23cf3bb2a552a2eeed8e4e`. Following changes are Markdown-only [skip ci]. Original local commits remain intact; published trees were checked for identity.

[CI run 38891870180](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38891870180): all 3 jobs SUCCESS.

| Verification | Actual result |
|---|---|
| Full TypeScript / Next.js build | PASS |
| Deal Room scoped ESLint | PASS, 0 errors / 2 pre-existing warnings |
| Directors/Brain/finance/Q&A/CEO Node regression | 150/150 PASS |
| Independent rule-level Decimal oracle | 80/80 PASS |
| Independent complete PRIVATE transaction Decimal oracle | 12/12 PASS |
| Isolated PostgreSQL CAS/ownership/replay/rollback/RLS/grants | 8/8 PASS |
| Actual API → services → Supabase/PostgREST → isolated PostgreSQL | 1/1 composite PASS, includes PRIVATE save/replay/reload and withdrawal to UNKNOWN |
| Mobile browser + existing Deal Room/Brain/Finder browser regressions | 4/4 PASS |
| Existing local MARKET/Radar regression | 97/97 PASS |

The mobile flow actually edits saved scenario/dates, answers all new qualifying/cost questions, saves/reloads the model and checks UNKNOWN actual liability, HOLD and no overflow. Financial-case changes reopen previous private qualifications unless explicitly reconfirmed in the same request. Tests verify preserved unaffected MARKET/VERIFY, changed CEO, immutable replies, tax cost/economic budget fencing, PCC replacement, reserve as liquidity rather than expense, no private dividend or tax on returned capital.

[Mobile evidence artifact](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38891870180/artifacts/12042177569), SHA-256 `b0be55e9ed241e3961f095a4c749011b15cc71ba7126d1c75aca9e651b92a217`.

### Delivered / explicit limits

One fully worked conditional calculation contract is delivered, not merely rate multiplication: eligible case facts, bounded dates, gross economic versus documented tax costs, income/PCC/PIT, separate capital/profit, estimated deadline cash flow, peak-equity ROI and reserve funding gap. Statutory source/change audit, formulas, independent fixtures and rollback are in `docs/deal-room-private-tax-model.md`. Reviewed coverage is 2026-04-01…2026-10-16; it is not a statute's inception/expiry. The model is retrospective/bounded and must not be extended to future sale dates without a new rules audit.

Actual transaction classification is NOT independently certified by software. Declarations/public reference are not proof of legal facts. Result therefore says MODELLED_ESTIMATE, actualLiability=null; canonical CFO netProfit/taxStatus stay UNKNOWN and CEO HOLD. No accountant review or tax filing was performed. Browser transport/auth is mocked; actual DB verified in a separate API test. No single authenticated browser-to-database test or physical Samsung test is claimed.

Remaining PRIVATE cases (other years, indexation, inheritance/gifts/marital ownership, business use, relief/depreciation, multiple sales, VAT, debt/investor), JDG and SP_ZOO remain UNKNOWN. Their required qualification/cost/timing/distribution inputs are documented; no new rates were added. General numerical JDG/SP_ZOO models are NOT implemented. Post-tax Max Buy/changed-cost stress remain UNKNOWN because invoices and legal conditions of the baseline do not prove candidate-price/future-cost eligibility; P2a pre-tax results retained. Issue #30 is not fully closed.

No production reads/writes, schema/grant migrations, activation, merge, deployment, paid API/service or changes to Watcher/OLX/Cloudflare/Render. New private flag OFF, requires existing CFO/TAX_REVIEW. Only synthetic data and disposable CI services. Terminal curl to public legal metadata failed due unavailable proxy; primary law was read through the browser tool, tests completed in CI. This did not justify bypassing networking. Earlier runtime CI was superseded by commits adding invalidation/reserve/UI safeguards; use only the final run above for delivered code.

### Exact next resume

“Kontynuuj Issue #30 od najnowszego checkpointu Draft PR #33, gałąź feat/deal-room-private-tax w /workspace/flip-deal-private-tax. Sprawdź HEAD/status bez resetu. Nie powtarzaj zielonego CI 38891870180 przy samych zmianach Markdown. Zachowaj sprawdzony kontrakt PRIVATE i UNKNOWN poza nim. Następny wariant opracuj dopiero po niezależnym audycie kwalifikacji, okresów i podstaw: JDG (forma, roczne księgi/remanent/składki/danina/VAT) albo SP_ZOO (reżim, podstawa CIT a zysk bilansowy, legalna wypłata i wspólnik). Nie dodawaj stawek bez zastosowania. Bez produkcji, aktywacji, merge i deploymentu.”

No credit exhaustion was observed; no balance/renewal/persistent-wake API is available. No fictitious monitor was created. This durable checkpoint records completed evidence and remaining scope without claiming a complete Polish tax platform.
