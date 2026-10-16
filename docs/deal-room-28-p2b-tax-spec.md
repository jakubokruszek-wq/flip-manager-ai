# CFO P2b — inactive specification, no runtime tax model

P2a deliberately outputs `taxStatus=UNKNOWN`, `netProfit=null` and a purchase HOLD. Existing configured acquisition tax/PCC is an inherited scenario, not a legal ruling. No private/JDG/company form, private-sale exemption, VAT recovery, income-tax rate or deductible expense is chosen automatically.

P2b requires a separate stacked Draft PR after P2a validation:
1. Audit investor-declared legal form, frequency/purpose of transactions, title/acquisition dates, VAT status, gross/net renovation and furniture quotes, eligible expense timing and financing/investor agreement. Ask only unresolved decision-relevant questions; keep evidence, declarations and assumptions separate.
2. Define dated, versioned tax scenarios reviewed with a qualified Polish accountant/adviser. Unknown material premises return UNKNOWN; never label pre-tax result as net. No automatic entity recommendation or claim that private sale is untaxed.
3. Reuse the P2a cash ledger/underwriting expense categories. Acquisition tax, VAT included in prices, corporate/income tax and investor distributions must have distinct bases and payment dates, with explicit overlap checks. Do not deduct the same VAT/PCC/financing charge twice.
4. Compute separate gross/pre-tax/post-tax scenario outputs only where the declared model is complete. Extend immutable before/after, source/version fencing, owner/RLS and retry coverage, plus stress and mobile question-answer tests.
5. New tax capability defaults OFF. No production migration/deployment or paid tax/bank service. Any legal content/rate/source must have a date and review provenance; calculations do not authorize a purchase or tax filing.

Acceptance: unknown form/tax basis stays UNKNOWN and blocks unconditional purchase; private/JDG/company variants use one identical property snapshot with no hidden rate/exemption default; known reviewed synthetic scenarios conserve cash and do not double costs. No runtime implementation is included here.
