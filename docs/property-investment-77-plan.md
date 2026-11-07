# Issue #77 — Nieruchomości → Inwestycje

Status: specification and read-only database reconnaissance. **Not implemented yet.**

## User journey
1. Finder/Watcher listings remain in their own discovery views. No automatic insertion into `properties`.
2. User explicitly adds a property to shortlist (`properties`) and tracks: do kontaktu → oglądanie → analiza → negocjacje → kupiona / odrzucona.
3. On `kupiona`, user explicitly confirms **Utwórz inwestycję**. The transition must be idempotent, retain the property ID and existing images/analysis, and not duplicate associated documents.
4. Investments list purchased properties, with overview, purchase documents, photos/design, renovation, purchases/invoices, sale and settlement.

## Existing production schema (read-only reconnaissance 2026-11-06)
- `properties`: id, status, images, listing_id, price, calculator_data, investment_analysis, purchase/renovation/sale cost fields, profit, roi.
- `deals`: id, listing_id, stage, facts, underwriting.
- `deal_room_workspaces`: deal_id, owner_id, state.
- `deal_evidence`: deal_id, type, document_id, source_url, structured_payload.
These tables are not interchangeable. Before implementing, inspect application routes, ownership/RLS, existing migration history and UI data flow.

## Safety and acceptance criteria
- No production migration or deploy until reviewed.
- No mutation to OLX, Facebook, Radar or existing deal-room records.
- Verify authenticated user ownership, RLS, and storage isolation; never expose secrets.
- Repeated purchase conversion produces one investment, never duplicate.
- Existing photos and underwriting survive conversion; rejected items remain searchable in archive.
- Tests for authorization, idempotency, rollback, navigation and existing flows.

## Next steps
- Inspect real code for `properties` list/detail, navigation, status writes and deal-room.
- Implement first stage in this feature branch and open Draft PR only when meaningful code and tests exist.
- Later stages: document/photo storage, OCR invoice review and deduplication, commitments vs paid costs, sale reconciliation.
