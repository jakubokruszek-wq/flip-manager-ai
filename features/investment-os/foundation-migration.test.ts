import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260912150000_investment_os_foundation.sql", "utf8");

test("foundation migration is additive, append-only and backend-only", () => {
  for (const table of ["listing_fact_observations", "deal_fact_override_events", "deal_fact_override_confirmations", "evidence_conflicts", "director_outputs", "ceo_decisions", "deal_actual_outcomes"]) assert.match(migration, new RegExp(`create table if not exists public\\.${table}`, "i"));
  assert.match(migration, /evidence_type text/);
  assert.match(migration, /content_hash text/);
  assert.match(migration, /director_runs_one_active_idx/);
  assert.match(migration, /INVESTMENT_HISTORY_APPEND_ONLY/);
  assert.match(migration, /apply_investment_override/);
  assert.match(migration, /confirm_investment_override/);
  assert.match(migration, /revoke all on table[\s\S]+from anon, authenticated/);
  assert.match(migration, /grant select, insert on table[\s\S]+to service_role/);
  assert.match(migration, /revoke update, delete on table[\s\S]+from service_role/);
  assert.doesNotMatch(migration, /drop table|delete from public\\.listings/i);
});
