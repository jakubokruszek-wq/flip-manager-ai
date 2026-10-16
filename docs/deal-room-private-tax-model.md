# Issue #30 — PRIVATE cash, same-year conditional transaction model v1

Base: Draft PR #32. Research: 2026-10-16. No new rate. New feature `DEAL_ROOM_PRIVATE_TAX_ENABLED` OFF, also requires CFO and TAX_REVIEW. This is a complete calculation for explicit facts, not an automated legal opinion: `MODELLED_ESTIMATE` is conditional, `actualLiability=null`, CEO still HOLD. A link or typed assertion cannot prove private qualification.

## Supported case / temporal boundary

Ordinary paid purchase of a Polish residential flat by its sole Polish-resident natural-person owner, sold outside business in the SAME 2026 calendar year. Both dates within **2026-04-01…2026-10-16**. This is the reviewed model coverage window, NOT an assertion the statute began/ended on those dates. Start anchors the PIT consolidation's legal-state date; end is the research cutoff. Same-year means no annual acquisition-cost indexation iterations. Both private/non-business and outside-VAT qualification must be expressly supplied; one does not imply the other. No previous business use, depreciation, inheritance/gift/marital settlement, other disposal that year, relief, foreign issue, loan/investor or disputed sale-market value. Purchase PCC ordinary, no exemption/sixth-unit rule, market value equals purchase price. Missing or conflicting prerequisite, dates outside coverage or costs outside ledger => UNKNOWN, never an assumed zero.

## Primary law, independently inspectable

[PIT, 592/2026 updated text, edition 2026-09-16](https://eli.gov.pl/api/acts/DU/2026/592/text/U/D20260592Lj.pdf): art. 10(1)(8) and 30e(6) distinguish private disposal from business; five years count from end of acquisition year. Art. 19 reduces consideration by disposal costs and allows market-value correction. Art. 22(6c–6f) separates documented acquisition/improvement costs and evidence from economic expenses, and defines annual indexation. Art. 30e specifies the income calculation, amortisation addition, separate income stream and rate. Art. 45(1), (1a)(3), (4)(4) governs separate PIT-39/payment. No depreciation/relief in this bounded case. [MF independent explanation](https://www.podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-nieruchomosci) confirms revenue/cost distinction and annual filing window. General rounding uses [Ordynacja art. 63, updated 622/2026](https://eli.gov.pl/api/acts/DU/2026/622/text/U/D20260622Lj.pdf). 2027-04-30 falls on Friday; payment is modelled at the statutory deadline under this snapshot, not as an investment-period expense on sale day.

Amendment audit for this small set of provisions (not a certification of all Polish taxes):

| Act | Inspected change / relevance |
|---|---|
| [779/2026](https://eli.gov.pl/api/acts/DU/2026/779/text/T/D20260779L.pdf), art. 1,5 | PIT bookkeeping art. 24a, chiefly 1 July 2026; no alteration of the selected private-sale provisions. |
| [846/2026](https://eli.gov.pl/api/acts/DU/2026/846/text/T/D20260846L.pdf), art. 4 | PIT 25b/30f/31d; outside this case. Ordynacja changes do not replace art. 63 general rounding. |
| [1079/2026](https://api.sejm.gov.pl/eli/acts/DU/2026/1079/text.pdf), art. 1 | Maritime exemptions in art. 21; outside selected no-relief case. |
| [1098/2026](https://eli.gov.pl/api/acts/DU/2026/1098/text/T/D20261098L.pdf), art. 32 | OKI-related changes; not a private-property exemption or amendment of 30e. Future-effective clauses are not imported as current rules. |
| [1123/2026](https://eli.gov.pl/api/acts/DU/2026/1123/text/T/D20261123L.pdf), art. 4 | Childcare/leave exemption art. 21(1)(67b); outside no-relief case. |

[PCC 191/2026](https://eli.gov.pl/api/acts/DU/2026/191/text/T/D20260191L.pdf), legal state 16 February: art. 2(4), 6(1)(1), 7(1)(1)(a), 7a,9. This model requires confirmed standard liability and market value; it does not infer exemption or omit the VAT-exempt-real-estate exception. [VAT 1263/2026](https://eli.gov.pl/api/acts/DU/2026/1263/text/T/D20261263L.pdf), art. 15: independent taxable-person/activity qualification is a prerequisite, not inferred from PIT. No output VAT/input deduction is modelled when outside-scope qualification is confirmed. No VAT exemption determination or rate selection is added.

Professional transaction review has NOT been performed. Source publication/edition dates are not rule inception dates. The verified object is the conditional calculation contract; actual factual qualification remains a human evidence task. Future rules, annual tax returns with multiple disposals and general business scenarios remain UNKNOWN.

## Cost reconciliation, cash, owner proceeds

Economic cash ledger comes from the existing CFO. Three **separately documented** amounts are requested: acquisition fees excluding price/PCC, value-increasing improvements during ownership, disposal costs. They must fit their existing gross economic cost buckets; they are not new expenses. Furniture, holding, contingency or other expenses are NOT automatically deductible merely because paid. Eligible improvements can include only the documented amount actually incurred, not an automatic full budget.

1. Calculate standard PCC on declared market value (=price), with whole-PLN base/tax rounding. Replace inherited embedded purchase-tax amount with that PCC; apply only the difference to acquisition cash/profit. Do not add a second PCC.
2. Tax revenue = sale proceeds − documented disposal costs. Acquisition basis = price + statutory PCC + documented other acquisition fees. Income = tax revenue − acquisition basis − documented improvements. Acquisition cost indexation is zero iterations for same-year purchase/sale; depreciation addition is zero only because excluded expressly.
3. PIT = existing 19% rule on nonnegative income with statutory rounding. Loss yields no tax/refund in this bounded case; no loss transfer is inferred.
4. Economic profit before PIT = CFO project profit − PCC replacement difference. After-reserve owner profit = that profit − PIT. This is profit, not final bank balance: returned original capital remains distinct. There is no company dividend layer for this private owner. No separate private withdrawal tax is invented.
5. Rebuild the cash ledger, replace PCC on the acquisition row, then append the modelled PIT payment at 2027-04-30. Reconcile ending equity to initial equity + after-reserve profit. Peak equity/ROI reflect this ledger. No funding or debt flows are admitted in this cash-only model.

Baseline single-case output is complete. Post-tax Max Buy and changed-cost stresses remain UNKNOWN: original invoices and eligibility declarations do not automatically describe different acquisitions/renovations/future sale dates. Existing P2a stresses/Max Buy remain explicitly pre-tax. Do not apply a fixed declared tax base to those candidates.

## Independent hand-calculated fixture

Purchase 300000; economic acquisition costs 14000 including PCC6000; renovation50000 (only40000 qualifies), holding10000, outside equipment10000, disposal9000, sale450000. Gross economic profit57000. Tax revenue441000; acquisition basis314000; improvements40000; income87000; PIT16530; owner profit after reserve40470. Initial capital500000 ends540470; original capital is not a dividend/profit. No second PCC. A fractional-price fixture independently checks replacement of embedded6000.50 by statutory6001: taxable income86973.99, PIT16525, after-reserve profit40448.99.

A separate Python Decimal implementation cross-checks complete income/cost/PCC/owner/net cash equations, in addition to existing 80 rule-level vectors. Node tests cover every missing eligibility fact, boundaries, negative results, over-budget/unproven deductions, malformed reference, mismatched ledger and financing rejection.

## Remaining variants and rollback

| Variant | State / next required facts |
|---|---|
| PRIVATE bounded cash case | MODELLED_ESTIMATE only for complete declared case; actual qualification/liability UNKNOWN. Other dates/titles/reliefs/amortisation/multiple sales/financing UNKNOWN. |
| JDG | UNKNOWN: actual business qualification, elected form/eligibility, inventory and annual base, contributions/solidarity, VAT entitlement and timing. Existing rule arithmetic cannot fill these facts. |
| SP_ZOO | UNKNOWN: classical/Estonian regime, reduced-rate conditions, company base vs accounting profit, shareholder identity/residence, company-law distribution and investor terms/timing. No automatic dividend on sale receipts or capital. |

No new rates are added. Switch PRIVATE flag off and explicitly refresh to remove projection; Q&A/immutable receipts remain. Existing projections and statutory form are not rewritten. Nothing here enables a production feature, migrates a schema or changes Radar/Watcher/OLX.

A change to price, area, resale, budget, horizon, financing or tax dates/scenario reopens stored private-case declarations (unless explicitly reconfirmed in the same command). The immutable prior receipt is retained. The next model is UNKNOWN until prerequisites are reconfirmed; a former qualification cannot silently survive a new economic case.
