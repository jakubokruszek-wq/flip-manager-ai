import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260912120000_create_investment_os_phase1.sql", "utf8");
const componentDir = "features/investment-os/components/";
const desk = readFileSync(`${componentDir}investment-desk.tsx`, "utf8");
const command = readFileSync(`${componentDir}ceo-command-center.tsx`, "utf8");
const board = readFileSync(`${componentDir}director-board.tsx`, "utf8");
const workspace = readFileSync(`${componentDir}decision-workspace.tsx`, "utf8");
const overrides = readFileSync(`${componentDir}override-panel.tsx`, "utf8");
const audit = readFileSync(`${componentDir}audit-panel.tsx`, "utf8");

test("migration keeps one additive deal per listing with backend-only writes", () => {
  assert.match(migration, /unique \(listing_id\)/i);
  assert.match(migration, /references public\.listings\(id\)/i);
  assert.match(migration, /alter table public\.deals enable row level security/i);
  assert.match(migration, /create table if not exists public\.deal_outcomes/i);
  assert.match(migration, /create table if not exists public\.director_scorecards/i);
  assert.match(migration, /create table if not exists public\.deal_evidence/i);
  assert.match(migration, /create table if not exists public\.director_runs/i);
  assert.match(migration, /create table if not exists public\.director_information_requests/i);
  assert.match(migration, /alter table public\.deal_outcomes enable row level security/i);
  assert.match(migration, /alter table public\.director_scorecards enable row level security/i);
  assert.match(migration, /alter table public\.deal_evidence enable row level security/i);
  assert.match(migration, /alter table public\.director_runs enable row level security/i);
  assert.match(migration, /revoke all on table[\s\S]+from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant select, insert, update on table[\s\S]+to service_role/i);
  assert.match(migration, /alter table public\.director_information_requests enable row level security/i);
  assert.match(migration, /revoke all on function public\.set_investment_os_updated_at\(\) from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /drop\s+(?:table|column)|truncate|delete\s+from\s+public\.listings/i);
});

test("Investment Command Center keeps the API contract and presents the CEO decision first", () => {
  assert.match(desk, /loadInvestmentDeal\(result\.id\)/);
  assert.match(desk, /\/api\/flip-finder\/listings\/\$\{result\.id\}\/investment/);
  assert.match(desk, /"x-flip-finder-action": "investment-os"/);
  assert.match(desk, /JSON\.stringify\(\{ overrides \}\)/);
  assert.match(command, /MAX BUY/);
  assert.match(command, /OPENING OFFER/);
  assert.match(command, /TARGET/);
  assert.match(command, /nextBestAction/);
  assert.match(command, /Otwórz plan działania/);
  assert.match(command, /missingBeforePurchase/);
  assert.match(command, /Czego jeszcze nie wiemy/);
  assert.match(desk, /<CeoCommandCenter/);
  assert.doesNotMatch(`${desk}${command}`, /computedProfit|computedScore/);
});

test("decision workspace exposes actual directors, progressive details, and accessible sections", () => {
  assert.match(board, /NOT AVAILABLE \/ FUTURE/);
  assert.match(board, /output\.validation\.checks/);
  assert.match(board, /output\.whatWouldChangeMyMind/);
  assert.match(workspace, /OVERVIEW/);
  assert.match(workspace, /MARKET/);
  assert.match(workspace, /ECONOMICS/);
  assert.match(workspace, /RISKS/);
  assert.match(workspace, /PLAYBOOK/);
  assert.match(workspace, /AUDIT/);
  assert.match(workspace, /aria-selected/);
  assert.match(workspace, /onTabKeyDown/);
  assert.match(audit, /sourceValue/);
  assert.match(audit, /overrideValue/);
  assert.match(audit, /effectiveValue/);
  assert.match(audit, /Evidence Fabric/);
});

test("override reset and save semantics stay scoped to the existing override endpoint", () => {
  assert.match(overrides, /void onSave\(payload\(\)\)/);
  assert.match(overrides, /void onSave\(\{\}\)/);
  assert.match(overrides, /askingPrice/);
  assert.match(overrides, /resalePerM2/);
  assert.match(overrides, /renovationPerM2/);
  assert.match(overrides, /holdingMonths/);
  assert.match(overrides, /Reset do źródła/);
  assert.doesNotMatch(`${desk}${command}${board}${workspace}${overrides}${audit}`, /supabase|createInvestmentDeal|initialize/);
});
