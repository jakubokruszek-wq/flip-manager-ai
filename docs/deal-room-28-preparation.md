# CFO / Issue #28 — preparation only

Issue #28 was read after implementing the explicit MARKET fallback. No CFO runtime change, branch, migration, flag activation or new PR is part of this preparation.

Next work starts from the latest verified `feat/deal-room-market` tree, in a new branch and stacked Draft PR whose base is `feat/deal-room-market`; preserve #25 and #27 without merge.

Audit before designing a model:
- Reuse underwriting scenarios, negotiated purchase, exact renovation total, transaction/holding/sale costs, existing Max Buy validator and source provenance. Identify every already-counted category to avoid duplicating PCC, notary, contingency, renovation, financing or holding costs.
- Reuse Q&A ownership/CAS, immutable receipts, version/source fencing, saved timestamps and before/after history. Financial parameters need numeric units and dependent invalidation, not unstructured notes interpreted as verified inputs.
- MARKET now exposes source label, indicative status, observation date and optional manual benchmark. CFO must propagate this uncertainty into cash-flow/stress analysis and CEO; an assumption cannot be upgraded into a transaction or guaranteed proceeds.

Proposed reviewable split:
1. P2a: typed cash-flow/financing contract, investor equity/reserve, stage/month schedule, peak financing need and deficit; cash/declared-loan/profit-share scenarios on one common deal snapshot; no second property calculator. Missing bank parameters remain UNKNOWN, loan approval never inferred. Reuse Q&A and show mobile before/after plus stress cases.
2. P2b: separate inactive specification for tax/legal models. No automatic private/JDG/company choice, no assumed zero tax and no “net profit” label without a specified material tax model. Escalate unknown legal/tax premises as questions for the accountant/adviser.

Required synthetic verification: purchase 300k/negotiated 260k, renovation 100k; cash/loan/profit-share; sale -10%, renovation +30%, +3 months; missing finance/tax inputs; retry/concurrent saves/owner/RLS; no duplicate expenses or capital/profit-share confusion; preserved snapshots and mobile Q&A → CFO → CEO. Full build/lint/Node, real isolated PostgreSQL and browser checks. Existing disabled flags remain off; any new CFO capability defaults off.

No production reads/writes, real bank data, deployment, live collection, paid AI/service, OLX/Watcher/Cloudflare/Render change, autonomous purchase or offer. Existing Vercel auto-preview is not a test environment until its secrets/database are separately verified; do not visit it with real data.
