# CFO P2a — audit, contract and model

Stacked on PR #27, retaining the Q&A/CAS and MARKET hierarchy. Feature `DEAL_ROOM_CFO_ENABLED` defaults OFF; it is evaluated only in the existing server engine. No new database object or dependency is required. Projection lives in the existing persisted `underwriting.result.cfo` JSON; the shared underwriting type adds only an optional erased type, and Finder/OLX calculations/defaults do not change.

## Audit

Existing underwriting already computes purchase tax (configured PCC assumption), fixed purchase/notarial cost, purchase commission, renovation, renovation contingency, holding, sales cost and optional percentage-based financing. The old CFO only restated totals and asked a generic financing question. There was no monthly cash ledger, equity/reserve input, explicit loan cash/debt service, investor principal/profit allocation or combined financing stress.

P2a uses the existing calculator with legacy percentage financing switched off **only inside the flagged Deal Room computation**. Legacy underwriting metrics remain the unlevered operating view; CFO adds the selected financing result and displays it separately. No old configured tax rate is represented as verified or changed. Income tax is never assumed zero: `taxStatus=UNKNOWN`, `netProfit=null`. P2b is separate.

## Inputs and Q&A

The existing answers endpoint, operator identity, per-deal owner, expected version, SHA-bound immutable replay, source fence, encrypted transport and round snapshots are reused. No new unauthenticated endpoint. Typed fields:

- `financingMode`: CASH / LOAN / INVESTOR. `costScope`: explicit BRUTTO confirmation that the renovation total includes VAT; unknown quote scope leaves the model UNKNOWN and asks for clarification. This declares the gross cost, not VAT recoverability or a tax/legal rule.
- `equity`, `liquidityReserve`, `deposit`, `equipment`: PLN; zero must be declared explicitly. Equipment is **outside** the declared renovation quote: declare 0 when already included. Deposit is part of purchase, not an extra purchase expense.
- `renovationMonths`: integer months, 1–120. It models equal monthly renovation milestones; greater than holding duration gives UNKNOWN and a question. Existing holdingMonths governs project duration.
- `loanAmount` PLN, `loanRate` nominal annual percent, `loanFee` PLN covering **all declared commissions/fees**, `loanTermMonths` integer 1–600, `loanSchedule` INTEREST_ONLY / ANNUITY, `loanSecurity` declaration/document reference. Missing terms do not become zero fees/interest. Rate is not RRSO or bank approval.
- `investorCapital` PLN, `investorProfitShare` and `investorLossShare` percent. Profit and loss shares are independently declared; no automatic 50/50 convention.

Numeric bounds, finite values, enums and integer schedule validation reuse the answer contract. New CFO fields are rejected while the flag is off. Required questions are generated from the selected model; other variants remain UNKNOWN until their fields are declared. Resolved current answers are hidden by the existing Q&A logic and remain editable in saved answers. Generic financing is removed when the typed CFO projection exists. Declaration does not mean verified funding/security or legal fact.

## Ledger and formulas

One source snapshot / MARKET valuation / renovation quote feeds all variants. No live pricing or bank service.

1. M0 pays deposit before the funding draw; the initial equity balance is explicit.
2. M1 receives the declared loan/investor capital and pays the rest of purchase, inherited purchase costs, inherited extra costs, renovation contingency and loan fee. Contingency is conservatively assumed spent up front.
3. M1…Mduration pay the declared equal renovation milestones and holding costs. Furniture outside the quote is paid immediately before sale. Final sale/debt/investor settlement occurs at the end of the same last month, without a free extra holding month. Receipts cannot finance earlier costs.
4. A loan draws once at purchase. Nominal interest is outstanding principal × annual rate / 12. ANNUITY uses the standard fixed-payment formula over declared term; interest-only repays at term or sale. Remaining principal is repaid on sale. No early-repayment fee is invented; it must be included in declared total loan fees. An overdraft or negative cash balance never silently creates a new loan.
5. `projectProfitBeforeTax = existing unlevered sale − existing project cost − outside equipment − declared loan interest/fees`. Principal draw/repayment is not profit or an operating cost. An investor's returned capital is likewise not an expense. Investor profit/loss share is allocated only after calculating project result; own result uses the remaining share. The model assumes the investor settles their declared loss share at exit, not guaranteed recoverability.
6. `peakOwnCapital` is the largest cumulative own cash requirement, before initial equity. `fundingGap=max(0,peakOwnCapital+liquidityReserve−equity)`. Reserve stays liquidity, not an extra profit deduction. ROI uses owner profit / peak own capital, UNKNOWN if denominator is zero; not tax-net return or annualized yield.
7. Break-even uses operating cost excluding percentage sale fee plus equipment/financing, divided by 1−sales fee rate. Per-variant Max Buy is a cent-rounded conservative bisection using the existing calculator and **same** minimum profit/margin/ROI thresholds, capped by its original maximum; loan/deposit feasibility is checked. It is a project threshold, not a bank borrowing limit. If no feasible boundary exists it is null.

Operational primary underwriting metrics are not relabelled as financing-adjusted net returns. CFO, the financial panel, canonical CEO and ACQUISITION expose the selected funding profit/gap/Max Buy separately from the underlying operating view. The hero owner-profit/ROI/boundary metrics do not fall back to operating numbers when selected financing is UNKNOWN. Cash-flow is a declared monthly model, not a precise bank-account transaction statement. Inherited settings and source estimates retain their assumption status.

## Stress and CEO

Reuse the same calculator with sale -5/-10%, renovation +20/+30%, holding +3/+6 months, nominal interest +2 percentage points and combined sale -10% / renovation +30% / +3 months / +2pp interest. Financing, cost reserve, selling costs and holding are recomputed once. All variants share the same property assumptions. Income tax remains unknown in every case.

CFO missing inputs, a funding gap, negative/unknown stress or UNKNOWN income tax prevents unconditional purchase and explains HOLD. Existing manual/hard reject still wins. CFO inputs change underwriting fingerprints and dependent CFO/ACQUISITION/CEO outputs; source facts and manual MARKET assumption remain intact. Existing canonical legal and indicative-market gates are not relaxed.

## Boundaries before activation

Only fixed nominal-rate annuity and interest-only debt; no automatic bank quote, RRSO computation, refinancing, multiple tranches, floating-rate curve or escrow. Equal monthly renovation schedule, not arbitrary milestone dates; contingency paid conservatively upfront. Equipment input must avoid overlap with the renovation quote. No individual tax/legal model is selected. Investor loss sharing is a declaration, not proof of enforceability or ability to contribute. Future P2b and controlled review are required before any purchase action. No production reads/writes, migration, paid service or manual deployment. Repository auto-preview is not used with real data.

## Rollback and operating limits

Keep DEAL_ROOM_CFO_ENABLED unset/false until review. Turning it off rejects new typed CFO answer commands and an explicit refresh rebuilds the legacy operating projection. Existing owner guards, stored answers and immutable receipts/rounds remain; no data is dropped or retrospectively rewritten. Do not remove historical snapshots to disable a feature. No database rollback is necessary for this change.

The complete monthly/stress projection and immutable response are larger than old scalar results. Month counts are bounded (holding ≤120 in Q&A, stress adds at most six) but retention/storage and latency should be observed in an approved test environment before activation. No paid account/quota was inspected or changed.

## Final verification — 2026-10-16

Draft PR #29: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/29, base `feat/deal-room-market` / #27 at `99881b45ebf2a79b0d2307570d834ef78e7805c5`. #25 and #27 remain drafts and untouched.

Tested remote code commit: `8b4aac9573d96eb55e3155e34ab95d0fa6098f6c` (local `3629aad05d522e21403805c2bab5f0785e0dd285`). Identical Git tree: `dfac306d32184431d0729d25aa8862ee3c3a552d`.

[Final CI: all three jobs SUCCESS](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38872535662):
- TypeScript, scoped ESLint, full Next.js build PASS. Two pre-existing lint warnings remain (unused `topologicalDirectorOrder`, existing image tag); zero lint errors.
- 133/133 Node PASS. Five new CFO tests cover purchase 300k / negotiated 260k / renovation 100k, cash/loan/investor on one base; exact principal/fee/share treatment; initial deposit before debt draw; reserve and gaps; missing financing parameters; combined stress and Max Buy; flag defaults/validation; Q&A and CEO fingerprints; annuity and cent conservation.
- 8/8 real PostgreSQL regressions PASS: existing ownership/CAS/race/receipt/source-fence/rollback/grant/RLS controls retained.
- 1/1 actual API → existing Investment OS services → Supabase/PostgREST → disposable PostgreSQL composite PASS. Includes new typed CFO answers and BRUTTO confirmation, funding shortfall then equity 500k, changed CEO, replay without duplicate round, persisted answer reload, null net profit; all preceding MARKET hierarchy/owner/response-loss checks still pass. No CFO migration is needed; projection is in the already atomically persisted JSON.
- 4/4 browser scenarios PASS: extended mobile Q&A negotiates 260k, changes renovation to 100k, submits CFO answers, verifies new CFO/CEO state, reloads, opens financial panel and checks no overflow at 390×844; existing Brain, Premium Deal Room and Finder regressions also pass.
- [Mobile screenshot artifact](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38872535662/artifacts/12034875004), SHA-256 `90ffab2f575cb83c31a4ce522a3a793eede38bcf4ae0d5ee8a50be143bec292e`.
- Existing market/Radar tests rerun locally: 97/97 PASS.
- Loaded Node suite coverage: 79.11% lines / 83.31% branches / 82.34% functions; not whole-repository coverage or coverage of the separate native service test.

Verification limits: browser transport/auth are existing fixtures, while actual handlers/services/PostgreSQL are a separate native integration test. There is no claim of one authenticated browser-to-real-DB scenario, physical phone test, production schema parity, bank approval, RRSO certification or tax validation. No live/production data was accessed. Initial null-safe type error and browser selector mismatch were corrected; earlier cancelled/failed runs are not counted as successes. The final follow-up commit is documentation only with [skip ci]; tested application code stays identical.

No new package, paid service, database migration or deployment command. Added-source credential-pattern audit found no tokens/private keys; this is not an exhaustive recognition of arbitrary private data. No changes in Watcher, Android, Radar collection, OLX/Cloudflare, production configuration or active filters. One erased optional type was added to the shared underwriting result; its calculation/defaults remain intact. P2b is an inactive separate specification: `docs/deal-room-28-p2b-tax-spec.md`.
