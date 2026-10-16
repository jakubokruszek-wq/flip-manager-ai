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
