# JDG conditional case and Deal Room audit

Base PR #33; research 2026-10-16. New JDG feature OFF. No production changes or new rate selection.

## Bounded legal contract, before implementation

[Current PIT text 592/2026](https://eli.gov.pl/api/acts/DU/2026/592/text/U/D20260592Lj.pdf), art. 9a/30c: linear taxation requires valid election and continuing eligibility, including employer restrictions. Art. 14/22/23/24: business revenue, documented eligible expenses and inventory matching; a residential trading good is not silently treated as a disposed residential fixed asset/private sale. Art. 30h: solidarity depends on all relevant annual income, not one project. Art. 44/45: advances and annual settlement differ. Only an ordinary same-year, cash-financed, fully sold trading-good case, KPiR, no other annual business income/inventory/losses/reliefs/fixed assets is supported. Both acquisition/sale 2026-04-01…2026-10-16, inherited reviewed snapshot window, not statute inception/expiry dates. Other cases UNKNOWN.

[MF linear PIT](https://www.podatki.gov.pl/podatki-firmowe/pit/informacje-podstawowe/co-jest-opodatkowane/opodatkowanie-podatkiem-liniowym) independently describes election and advance timing. [MF health deductions](https://podatki.gov.pl/ulgi-i-odliczenia/odliczenie-skladek-na-ubezpieczenie-zdrowotne-pit) confirms the combined 2026 health cost/income-deduction cap PLN14100. This model uses deduction from income only, never both cost and deduction. Social contributions must be eligible, paid and not already in project costs; Labour Fund eligible payments are costs once. No automatic eligibility, loss relief or solidarity exemption: explicit all-income under-threshold assessment is required and the model rejects its own taxable income reaching PLN1m.

[VAT 1263/2026](https://eli.gov.pl/api/acts/DU/2026/1263/text/T/D20261263L.pdf), art. 2(14),43(1)(10),43(10–11),86,91: support only an independently qualified used-flat exempt supply, occupation/improvement history establishing the statutory interval, no option to tax, no input deductions/adjustments. A purchase outside/exempt VAT, ordinary PCC with market value equal price, no exemption/art.7a, is a distinct prerequisite; [PCC191/2026](https://eli.gov.pl/api/acts/DU/2026/191/text/T/D20260191L.pdf), art.2/6/7/9. No output VAT for this qualified exempt supply; it is NOT labelled a zero-rated or outside-scope business sale. Taxable supplies/partial deductions/refunds UNKNOWN.

[Official ZUS 2026 explanation](https://www.zus.pl/documents/10182/13364587/Sk%C5%82adki%2Bprzedsi%C4%99biorc%C3%B3w%2Bw%2B2026%2Broku_DFF.pdf) and [Biznes.gov.pl contributions](https://biznes.gov.pl/pl/portal/00274) show why linear health contributions cannot be modelled as a flat addition to project PIT: income/months, minimum, annual reconciliation and taxpayer category matter. The January/February contribution-year boundary also matters. No ZUS rate/minimum/category is inferred or added by software. Instead require an independently reconciled complete schedule for the sole-business case, including social, Labour Fund, health and PIT payment dates and amounts; 2026 social/health payments and zero later contribution/refund adjustment only. Health deduction is explicit, capped by actual 2026 health payments and statutory cap. If contribution qualification/annual settlement/schedule is unknown, the WHOLE after-tax estimate is UNKNOWN. Provided dates are model inputs, not software certification that a filing/payment is timely.

## Equations and accounting boundary

Reuse CFO gross economic cash ledger, no second operating-finance engine. Replace embedded acquisition tax with rounded statutory PCC. Separately declared documented acquisition fees (excluding price/PCC), operating costs and sale costs must fit corresponding gross CFO buckets. ZUS must be outside those buckets. Taxable income = sale − price − PCC − eligible acquisition/operating/disposal costs − Labour Fund − eligible social paid − eligible health income deduction. Existing linear rule computes annual PIT on positive rounded base; no refund inferred for losses. Schedule PIT total must equal that computed annual amount; overpaid advances/refund or unresolved settlement UNKNOWN.

Owner profit after taxes/contributions = CFO economic profit − PCC replacement difference − social − Labour Fund − full health cash payments − PIT. Health deduction reduces PIT basis, it is not a second cash credit. No dividend layer for own JDG funds. Cash dates merge supplied payment schedule with CFO planning dates: equity means opening 2026 balance, M0/M1 acquisition-date deposit/purchase, monthly operating rows at successive month starts, equipment/exit at declared sale date. Same-day contribution payments precede sale receipts conservatively. Operating dates remain a declared forecast, not imported bank transactions. Cash ending must reconcile to equity + after-tax profit; reserve is a liquidity requirement, not an expense. Post-tax Max Buy/stress remain UNKNOWN until candidate costs and annual contributions are requalified.

## Qualification and evidence

Explicit confirmations plus a safe public reference are required. No URL fetch or automatic legal certification. Status MODELLED_ESTIMATE is conditional on those declarations; actualLiability/null canonical net remain UNKNOWN, CEO HOLD. No accountant review by this implementation is claimed. Financial case changes invalidate old JDG declarations unless explicitly reconfirmed. Same Q&A/receipt/CAS/owner security, default OFF. Unsupported tax form, financing, VAT, other annual activity or ambiguous amounts -> questions/UNKNOWN.

## Stage 2 audit plan

Use three synthetic Łódź listings: high profit, small margin, hard legal/identity reject. Exercise existing Finder adapter/CanonicalDeal/Brain, MARKET Radar and general/district/city fallback, renovation, underwriting, CFO, RISK_LEGAL, CEO. Assert relative profits, rejection precedence and no auto-BUY on missing qualification; answer persistence/replay/withdraw/change/reanalysis and owner boundaries. Browser transport and actual API/DB are separate tests and must not be described as one authenticated browser→DB test. Record only actual finished CI results in checkpoint.

## Actual three-property evidence

Executed through actual listing API/services/PostgREST in disposable PostgreSQL, using the existing Finder listing adapter. Each owned case selected the same 12 qualified synthetic Radar offers. Figures below are **operating results BEFORE income tax/contributions**, not net returns or transaction prices.

| Synthetic Łódź case | Purchase PLN | Operating profit PLN | CEO |
|---|---:|---:|---|
| High-profit opportunity | 200000 | 150732.50 | HOLD / ZBIERZ DANE |
| Positive thin margin | 340000 | 7932.50 | HOLD / ZBIERZ DANE |
| Risk / known hard reject | 680000 | -338867.50 | ODRZUĆ |

The third fixture has an explicit existing human hard-reject veto (and the pure regression also a material area conflict). This verifies veto precedence/persistence; it does NOT prove automatic legal-defect diagnosis. High profit is not authority to BUY while legal/tax/evidence gates remain open. The positive thin-margin case is asserted above zero and below PLN20000 in the real API fixture; the pure general-benchmark variant uses its own lower-profit threshold.

All ten director projections were present. Saving renovation 40000→100000 lowered the existing financial result and changed the dependent CEO; replay was immutable and a subsequent GET retained the answer. Excluding the owner's Radar sample switched to actual eligible general comparisons, labelled indicative, with no BUY. Earlier existing composite additionally covers district/city fallback and no-data blocking. Another composite verifies full JDG field/payment save/replay/reload, conditional annual PIT reconciliation, and UNKNOWN after withdrawing the ZUS assessment. It also preserves prior PRIVATE/security/owner/CAS tests.

## Audit fixes

1. Brain CFO previously described only pre-tax liquidity, ignoring the canonical tax projections. It now also shows explicitly conditional owner result/funding gap and unresolved tax requirements, without marking actual tax verified.
2. Brain's question engine previously omitted the tax questions that canonical Q&A supported. It now routes active tax questions to UNDERWRITER/CFO/CEO. The original questions/receipt system is reused.
3. A single-line answer input cannot preserve a multi-payment schedule. Only that answer now uses an accessible bounded multiline field; long question legends are width-limited for mobile. Other answer types unchanged.
4. PRIVATE and JDG share existing CFO-ledger reconciliation. No second renovation/financing/Finder calculator was introduced. Source identity, Radar deduplication, owner and buy gates were retained.

## Readiness boundary

Code is suitable for **controlled synthetic tests in a confirmed isolated environment**, subject to final CI linked in checkpoint. No interactive user test environment was deployed or activated by this task. Users cannot start a hosted test merely by opening this PR; no unverified repository preview should be used against production Supabase. Preparing an accessible isolated host requires separate authorization under the no-deployment instruction.

Not ready for production decisions, automatic tax filings or general JDG tax advice. Election, trading classification, VAT occupation/improvement history, eligibility of costs and contributions remain declared/evidence-dependent. Software does NOT establish ZUS category, monthly minima/bases or annual health reconciliation; it consumes an externally reconciled schedule and blocks missing/adjusted cases. The synthetic schedule/oracle checks algebra/cash, not statutory correctness of an actual ZUS assessment. Unsupported scale/ryczałt, taxable/partly deductible VAT, other annual activity, contribution/PIT refunds, loans/investors and SP_ZOO remain UNKNOWN. Actual liability/canonical net stay UNKNOWN, CEO HOLD; post-tax Max Buy/stress not implemented. Coverage ends at 2026-10-16 and cannot be silently extended to a future flip.

The browser test uses mocked API/auth transport and real canonical calculations; real API→DB is a separate composite. No single authenticated browser→DB test, physical Samsung test or tax return submission was performed. No production/paid service, schema change or feature activation.

For a future controlled test: first verify database/credentials/network isolation; use only the three synthetic fixtures and a synthetic operator; enable QA/CFO/TAX_REVIEW/JDG only in that disposable process; verify missing qualifications give questions/UNKNOWN, then save the complete supplied assessment and payment plan, reload, alter a price/budget and confirm old assessment reopens. Withdraw a ZUS answer and confirm UNKNOWN. Verify Radar exclusion yields indicative general evidence and hard reject survives all recalculation. Disable flags and refresh to roll back projection without deleting receipts. No real investor identities, payroll, bank documents, tokens or Facebook sessions.

## Final verification

[CI38907529725](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38907529725), runtime `acb39a35b5d74c30ee7671d68e3670cb384bdfd3` (local `9069e4b`), all three jobs SUCCESS. TypeScript/full Next.js build PASS; scoped Deal Room ESLint PASS, 0 errors/2 pre-existing warnings. Node158/158; SQL8/8; actual API/DB2/2; browser4/4; independent rule80/80, PRIVATE12/12 and JDG algebra4/4; local existing MARKET/Radar97/97. The JDG oracle does not certify a statutory ZUS schedule. No failed run remained; initial full run38906802090 also passed, follow-up tightened the positive-margin assertion and emitted synthetic per-case evidence.

[Mobile screenshots](https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38907529725/artifacts/12048618304), SHA256 `bb2e3c659c6edf4cf721dc5321f9cc2649cc272874d7aef8772d9234728cffe5`.

Draft PR #34: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/34, stacked on #33. Final changes after tested code are documentation only. Full durable checkpoint: `docs/deal-room-30-progress.md`. All new features OFF; no merge, deployment, production migration, paid API/service or Watcher/OLX changes.
