# Deal Room MARKET — Issue #26

## Current contract: explicit automatic fallback (investor update 2026-10-16)

This section supersedes the original fail-closed-on-insufficient-Radar design. With the integration flag enabled, refresh prefers sufficient fresh Radar, then general `resale_comps` (at least three independently identified, eligible listings), then the most specific current `market_assumptions` (district/profile before city). An explicit investor `resalePerM2` always has precedence and retains its timestamp; the available benchmark remains visible separately. With no usable source, valuation remains missing and asks for an investor assumption. Infrastructure/permission errors still surface as errors rather than masquerading as an empty sample.

General comps require the subject city/district, building type, rooms, the existing ±15% area rule, confirmed renovated HIGH standard, consistent amounts, safe HTTPS link and fresh per-comp dates. The legacy sidecar does not persist a market-type column: accept explicit secondary-market metadata or unambiguous secondary-market description; unknown market is rejected. Private rows from another operator, removed/excluded/outlier rows, subject self-comparisons and stale dates are not eligible. Only proven cross-unit identity is merged; weak price/title similarity is never proof. The actual legacy schema is shared (public SELECT policy), not an owner-scoped store; future owner-labelled rows are additionally fenced.

Every fallback is **WYCENA ORIENTACYJNA**, with source label, location/profile, independent sample count, observation date, confidence (at most 60 before penalties) and a question proposing the source-derived rate. It is available to the existing underwriting for ROI/Max Buy. City fallback level 4 is allowed for provisional calculations only; indicative evidence fails the market purchase gate and cannot create an unconditional KUP even under a relaxed custom purchase policy. MARKET, SALE and CEO explain the source and uncertainty. Manual override remains distinct from the benchmark and does not become a verified transaction.

General/assumption freshness currently uses a conservative 30-day cap; Radar uses its configured cap and the existing decision policy additionally validates freshness. A refresh with a sufficient Radar sample switches back to Radar and recalculates dependent fingerprints, economics and CEO. No schema or production change is required.


## Audit and boundary

PR #25 supplies the persistent answer/CAS/reanalysis loop. Previously MARKET only read global `resale_comps` and market assumptions, the selector capped its sample at ten, did not independently enforce every comparable's age, and had no direct owner-scoped Radar adapter.

This stacked PR adds a read-only adapter; it does not collect listings, change Radar/OLX ingestion, touch Watcher, change investor filters or require a database migration. It reuses `getRadarResults`, saved per-operator Radar settings, confirmed identity grouping, exclusions and `calculateResaleArv`. Existing routes, decision policy, deterministic directors, underwriting and CAS remain authoritative.

## Activation and privacy

`DEAL_ROOM_RADAR_ENABLED` defaults off. `DEAL_ROOM_QA_ENABLED` is separately off by default. No environment was activated remotely. `DEAL_ROOM_RADAR_MAX_AGE_DAYS` defaults to 30; invalid/nonpositive values fail closed. Existing decision policy's maximum age additionally applies. The sample minimum is ten independent units, matching Radar, and cannot be lowered below ten by this adapter.

Radar settings/results are read with the authenticated operator id. Owner-less legacy deals must first acquire ownership in an ordinary Q&A round; until then only the shared general-evidence/assumption hierarchy is available. A subsequent explicit refresh loads the owner's Radar. This prevents storing one operator's private sample in a legacy shared deal. Existing Q&A owner enforcement survives disabling either flag.

## Selection and price algorithm

Saved Radar filters narrow district, market, area, rooms and sources before adaptation. The subject further requires an exact normalized city/district, known compatible building type (BLOCK/blok alias), exact room count, area within 15%, secondary market and fresh-renovation standard. Unknown type/dimensions/standard are not guessed. Tenements cannot enter this Radar sample. No hardcoded Łódź investment district profile is installed.

This is district-level comparison: street, precise distance, floor and photo association are not established by the stored Radar model. Confidence is capped at 70 even for a large sample, below the default BUY threshold. A different microdistrict within a broad district remains an explicit risk; do not describe these as verified same-street comparables.

Every retained comp must be active, not operator-excluded, without verification contradictions, have a safe stored HTTPS link and a consistent positive total price/area ratio. Collection date, rather than merely last-seen, must fall within the per-comp age bound; future/missing dates fail closed. A representative/alternate matching the subject URL is excluded. A source/external id matching the subject is excluded. Links are not fetched or represented as currently available; photographs are not loaded or asserted to belong to these units.

Confirmed portal IDs and strict `canonical_unit_id`/`portal_shared_unit_id` groupings are reused. Similar titles, price, address and area alone never merge units. Existing Radar manual exclusion propagates across a confirmed group; conflicting alternate price (>10%), area (>0.5m²) or rooms excludes the group. Extra adapter-level keys protect independently supplied fixtures against duplicate inflation. Finder manual grouping has Finder listing/filter IDs, not Radar IDs: no invented mapping or cross-table write is made. Unproven syndication remains separate, a known limitation requiring operator review in the existing Radar UI.

All retained independent units feed the existing ARV weighted quantiles (20%/80%) and weighted mean for low/base/high. Weight is similarity 0.8 times existing freshness factors (1/0.7/0.4/0.1) and HIGH standard confidence. The default 30-day bound makes weights equal. No transaction discount is applied twice: the ARV's separate `estimatedSalePrice` is not used as another input discount. These remain ASKING scenarios, not actual transactions or guaranteed proceeds. Small/empty Radar samples trigger the explicit current fallback hierarchy above; stale or invalid general evidence is never silently used. Zero is only an invalid blocked range, never a displayed valid valuation.

## Reanalysis and presentation

Market input fingerprints include the actual sample, prices, timestamps and rejection audit; downstream UNDERWRITER and CEO use existing dependencies. Saved explicit resale assumptions remain primary, retain their original timestamp and expose a separate Radar reference. Changing the sample still invalidates this comparison and downstream outputs. Existing legal/document gates are not relaxed.

Refresh is explicit: return from Radar and use the existing Deal Room refresh action. This recomputes using current exclusions/settings, without overwriting the investor's resale assumption. There is no background push subscription. Accepted comps show source link, dates, district, area, rooms, type, standard, status and match limitations. Rejections are auditable in blocked warnings or the market result. Use the existing Radar page for exclusion/review rather than a second accept/reject UI.

## Verification

Synthetic fixtures cover 20 independent units, 20 advertisements / five proven units, stale dates with a fresh last-seen, missing fields/type/standard conflicts, exclusion, inconsistent alternates, equal-price distinct units and unsafe links. Engine regression checks financial and CEO fingerprint changes, lower profit after a lower market scenario, no BUY for insufficient/stale samples and preservation of an investor assumption.

The isolated service harness applies the existing Radar migration to disposable PostgreSQL, seeds only synthetic rows, invokes real Investment OS/API/PostgREST and checks that operator exclusions shrink the sample and recompute CEO. No production connection or copied records are used. Final run/results will be recorded below after completion.

## Remaining limitations before activation

- No confirmed transaction prices, physical valuation or validated current Łódź market-price claim.
- Radar configuration is reused; Deal Room has no selected Finder-filter ID contract. It cannot silently choose among multiple Finder profiles or apply Finder-only manual identity decisions to unrelated Radar IDs.
- Proven explicit syndication is deduplicated; heuristic unconfirmed syndication requires existing operator review. Micro-location and photo proof remain unknown.
- Refresh does not transactionally lock the entire Radar sample; it records the snapshot read. Concurrent operator changes are reflected on the next refresh, not by mutating an immutable past round.
- The tests use isolated synthetic data, not production schema/data parity or live portal validation.
- Existing private owner/CAS, legal and evidence gates remain required. No recommendation is permission to buy.

## Previous checkpoint — before the investor fallback update

- Draft PR #27: https://github.com/jakubokruszek-wq/flip-manager-ai/pull/27 (base `feat/deal-room-qa`, keeps #25 intact).
- Tested remote code commit: `f2fbe4589134e19f3121072d6bec9afc242c2469`; corresponding local commit `08a9493`.
- Identical local/remote tested tree: `7ada7c47c54a9a7e6a3eaa6d1c1b109db086d958`.
- Final CI: https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38863006442 — all three jobs SUCCESS.
- TypeScript, scoped ESLint, full Next.js production build: PASS.
- Node Investment OS/Brain/Q&A/underwriting suite: 123/123 PASS (including seven new Radar scenarios).
- PostgreSQL CAS/ownership/retry/source-fence/RLS/grant regression: 8/8 PASS.
- Real API/service/PostgREST/PostgreSQL composite: 1/1 PASS. Includes actual Radar migration on a disposable database, two operators' synthetic samples, no private sample persisted into an unowned deal, owner-only sample, exclusions reducing 20 to five comps and recomputed blocked MARKET/CEO.
- Browser scenarios: 4/4 PASS (mobile Q&A/reload, Brain, Premium Deal Room, Finder).
- Existing market-intelligence and Radar qualification/stats run locally: 97/97 PASS.
- Loaded Node suite coverage: 78.54% lines / 83.67% branches / 82.03% functions. Adding imports exposes more server modules in this denominator; this is not whole-repository coverage. Native service/database behavior is tested separately rather than counted as Node unit coverage.
- Added-lines credential-pattern audit: no matched credentials. This is a bounded pattern check, not a guarantee that arbitrary private data can be automatically recognized.
- No production or live portal tests performed; no claims about current real market prices. Browser transport uses existing fixture mocks; the real database path is a separate native API test, not one authenticated browser-to-DB scenario.
- No new paid service or model, no remote migration or deployment. CI uses existing GitHub Actions with disposable services; account-level quota/billing was not queried.
- Initial test setup failures (SQL string delimiter, missing empty historical queue dependency) were fixed; interrupted earlier runs are not counted as successes.

The final follow-up changes only this Markdown report (`[skip ci]`); the tested application tree content is unchanged apart from documentation. Before activation, review the selection/profile/identity limitations above, obtain suitable independent comparables and legal evidence, provision the existing Q&A draft only in an approved environment, claim an owner through Q&A and explicitly refresh. This PR neither performs nor authorizes production activation.

## Current fallback verification — 2026-10-16

Supersedes the previous checkpoint for current code. Tested remote commit `121dc3064d620c561236e7b3644a6ba676027895` (local `101352f`), tree `43fdff991e2e0367e42502d9335362acc74fd008`.

Final CI: https://github.com/jakubokruszek-wq/flip-manager-ai/actions/runs/38868982586 — app, PostgreSQL and service jobs all SUCCESS.

- TypeScript, scoped ESLint, full Next.js build PASS.
- 128/128 Node PASS, including strict general-comp privacy/eligibility/identity/date checks, indicative city/district financial calculations, explicit questions, manual-vs-general benchmark and no unconditional BUY.
- 8/8 PostgreSQL CAS/owner/retry/RLS/grant regressions PASS.
- Real API → existing services → PostgREST → PostgreSQL composite PASS: insufficient Radar (four units), valid general comps; empty Radar plus general comps; district then city assumption; manual 11,000 with a different general benchmark then withdrawal; no evidence; stale general comps; return to 12 Radar units and new underwriting/CEO. Existing response-loss/replay, source fence, owner guard and hard-reject checks still PASS. Applies actual resale-comp and Radar migrations only to disposable synthetic fixtures.
- 4/4 browser regressions PASS. Browser API transport is mocked; native real-DB integration is separate. There is no new claim of one browser-to-live-database test.
- Existing market/Radar regressions rerun locally: 97/97 PASS. Four new pure helper tests also pass locally; engine/build/database tests used full dependencies in CI.
- Loaded Node coverage: 78.74% lines / 83.35% branches / 82.35% functions; not whole-repository coverage.
- Initial new assumption fixture was wrongly labelled RESALE_COMPS with zero comps and correctly failed validation. The fixture was corrected; purchase/validation gates were not weakened to make it pass.
- No new migration, paid service, production read/write, live data collection or manual deployment. Existing repository GitHub→Vercel preview automation was not invoked for testing or accessed with real data; its configuration was not changed.

Follow-up documentation-only commit uses `[skip ci]`; tested application code is unchanged. CFO preparation is in `docs/deal-room-28-preparation.md`, with no CFO runtime implementation in this PR.
