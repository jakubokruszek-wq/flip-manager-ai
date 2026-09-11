import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260912120000_create_investment_os_phase1.sql", "utf8");
const desk = readFileSync("features/investment-os/components/investment-desk.tsx", "utf8");

test("migration keeps one additive deal per listing with backend-only writes", () => {
  assert.match(migration, /unique \(listing_id\)/i);
  assert.match(migration, /references public\.listings\(id\)/i);
  assert.match(migration, /alter table public\.deals enable row level security/i);
  assert.match(migration, /revoke all[\s\S]+from anon, authenticated/i);
  assert.match(migration, /grant select, insert, update[\s\S]+to service_role/i);
  assert.doesNotMatch(migration, /drop table|delete from public\.listings/i);
});

test("Investment Desk exposes CEO, directors, provenance-safe overrides and reset", () => {
  for (const label of ["CEO", "Zespół inwestycyjny", "Cena ofertowa", "Pierwsza oferta", "Cel zakupu", "Maksimum", "Flip Score", "Confidence", "Reset do źródła"]) assert.match(desk, new RegExp(label));
  assert.match(desk, /x-flip-finder-action/);
  assert.doesNotMatch(desk, /computedProfit|computedScore/);
});
