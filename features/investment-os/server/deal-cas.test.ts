import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { commitDealCas, initializeDealWithCas, InvestmentDealVersionConflict } from "./deal-cas.ts";
import { investmentInitializeResponse } from "./investment-initialize.ts";
import { investmentDealReadResponse } from "./investment-read.ts";

test("parallel initialize requests create one listing-keyed deal and both return success", async () => {
  let storedId: string | null = null;
  let storedVersion = 0;
  const storedSourceUpdatedAt = "2026-09-12T10:00:00.000Z";
  let inserts = 0;
  let candidateSequence = 0;
  const initialize = async (listingId: string) => initializeDealWithCas({
    compute: async () => ({ value: { id: `candidate-${listingId}-${++candidateSequence}`, listingId }, expectedVersion: 0, sourceUpdatedAt: storedSourceUpdatedAt }),
    commit: async (candidate) => {
      await Promise.resolve();
      if (storedId !== null || candidate.expectedVersion !== 0 || candidate.sourceUpdatedAt !== storedSourceUpdatedAt) throw new InvestmentDealVersionConflict();
      storedId = candidate.value.id;
      storedVersion = 1;
      inserts += 1;
      return 1;
    },
    readCurrent: async () => storedId ? { value: { id: storedId, listingId: "listing-1" }, sourceUpdatedAt: storedSourceUpdatedAt } : null,
  });

  const responses = await Promise.all([
    investmentInitializeResponse("listing-1", initialize),
    investmentInitializeResponse("listing-1", initialize),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const results = await Promise.all(responses.map(async (response) => (await response.json() as { deal: { id: string } }).deal));
  assert.equal(inserts, 1);
  assert.equal(storedVersion, 1);
  assert.equal(new Set(results.map((item) => item.id)).size, 1);
});

test("parallel stale deal writes have exactly one winner and an explicit version conflict", async () => {
  let version = 8;
  const write = (expected: number) => commitDealCas(async () => {
    await Promise.resolve();
    if (version !== expected) return null;
    version += 1;
    return version;
  });
  const results = await Promise.allSettled([write(8), write(8)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof InvestmentDealVersionConflict);
  assert.equal(version, 9);
});

test("repeated read-only GET contract returns existing state or NOT_COMPUTED without mutation", async () => {
  let selects = 0;
  const writes = 0;
  const current = { id: "deal-1" } as never;
  const read = async (id: string) => { selects += 1; return id === "existing" ? current : null; };
  for (let index = 0; index < 3; index += 1) {
    const response = await investmentDealReadResponse("existing", read);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { deal: { id: string } }).deal.id, "deal-1");
  }
  const missing = await investmentDealReadResponse("uncomputed", read);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { ok: false, code: "NOT_COMPUTED" });
  const serviceSource = readFileSync(new URL("./deal-service.ts", import.meta.url), "utf8");
  const getter = serviceSource.match(/export async function getInvestmentDeal[\s\S]*?(?=export async function initializeInvestmentDeal)/)?.[0] ?? "";
  assert.match(getter, /readStoredDeal\(db, listingId\)/);
  assert.doesNotMatch(getter, /\.insert\(|\.upsert\(|\.update\(|\.rpc\(|persistIntelligence/);
  assert.equal(selects, 4);
  assert.equal(writes, 0);
});

test("migration enforces unique-key idempotency, source freshness, CAS, and backend-only RPCs", () => {
  const migration = readFileSync(new URL("../../../supabase/migrations/20260912180000_investment_os_deal_cas.sql", import.meta.url), "utf8");
  const foundationMigration = readFileSync(new URL("../../../supabase/migrations/20260912120000_create_investment_os_phase1.sql", import.meta.url), "utf8");
  assert.match(foundationMigration, /constraint deals_listing_id_key unique \(listing_id\)/i);
  assert.match(migration, /add column if not exists version integer not null default 1/i);
  assert.match(migration, /on conflict \(listing_id\) do nothing/i);
  assert.match(migration, /d\.version = p_expected_version/i);
  assert.match(migration, /l\.updated_at is not distinct from p_source_updated_at/i);
  assert.match(migration, /INVESTMENT_DEAL_VERSION_CONFLICT/);
  assert.match(migration, /revoke all on function public\.persist_investment_deal_cas[\s\S]+from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.persist_investment_deal_cas[\s\S]+to service_role/i);
  assert.match(migration, /drop function if exists public\.apply_investment_override\(/i);
});
