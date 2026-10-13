import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { readOnlySupabase, ReadOnlyViolationError } from "./read-only-supabase.ts";
import { buildDedupFixture, buildDedupReport, createSelectRecorder, FINDER_READ_TABLES, focusListingIds, type DedupFixture } from "./dedup-diagnostics.ts";
import type { IdentityPairDiagnostic } from "../property-identity.ts";

/**
 * Replays rows exported READ-ONLY from Production with
 * scripts/finder-dedup-diagnostics.mts --export through the real Finder read
 * path. The export holds the exact SELECT results the Finder read (titles,
 * descriptions, floors, addresses, photos, memberships, snapshots), so the
 * test runs on faithful copies instead of invented descriptions.
 */
const PRODUCTION_FIXTURE = new URL("./__fixtures__/finder-dedup-production.json", import.meta.url);

let client: { from: (table: string) => unknown } = new FakeFacebookSupabase() as unknown as { from: (table: string) => unknown };
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => client } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => client } });
const { getFilterResults, resetFinderReadCachesForTests } = await import("./filter-results.ts");

function replayClient(fixture: DedupFixture) {
  const fake = new FakeFacebookSupabase();
  for (const table of FINDER_READ_TABLES) fake.seed(table, fixture.tables[table] ?? []);
  return { fake, client: readOnlySupabase(fake as unknown as { from: (table: string) => unknown }) };
}

async function readBoth(fixture: DedupFixture) {
  const now = Date.parse(fixture.now);
  resetFinderReadCachesForTests();
  const before = await getFilterResults(fixture.filterId, false, now, fixture.operatorId ?? undefined, { identity: { crossPortalEvidence: false } });
  resetFinderReadCachesForTests();
  const pairs: IdentityPairDiagnostic[] = [];
  const after = await getFilterResults(fixture.filterId, false, now, fixture.operatorId ?? undefined, { identity: { onPairAssessed: (pair) => pairs.push(pair) } });
  assert.ok(before && after);
  return { before, after, pairs };
}

test("the diagnostics client is read-only: every write, rpc and storage call throws before reaching the database", async () => {
  const fake = new FakeFacebookSupabase().seed("listings", [{ id: "a", price: 1 }]);
  const guarded = readOnlySupabase(fake as unknown as { from: (table: string) => { update: (value: unknown) => unknown; insert: (value: unknown) => unknown; upsert: (value: unknown) => unknown; delete: () => unknown; select: (columns: string) => unknown } } & { rpc: (name: string) => unknown; storage: unknown });
  for (const write of [() => guarded.from("listings").update({ price: 2 }), () => guarded.from("listings").insert({ id: "b" }), () => guarded.from("listings").upsert({ id: "a" }), () => guarded.from("listings").delete(), () => (guarded.rpc as (name: string) => unknown)("anything")]) {
    assert.throws(write, ReadOnlyViolationError);
  }
  assert.throws(() => (guarded.from("listings").select("id") as unknown as { eq: (column: string, value: string) => { update: (value: unknown) => unknown } }).eq("id", "a").update({ price: 3 }), ReadOnlyViolationError, "a write method reached through a filter chain is blocked too");
  const { data } = await (guarded.from("listings").select("id,price") as unknown as Promise<{ data: unknown }>);
  assert.deepEqual(data, [{ id: "a", price: 1 }]);
  assert.deepEqual(fake.rows("listings"), [{ id: "a", price: 1 }]);
});

test("an export recorded through the read-only client replays to the same Finder cards (round trip of the diagnostics script)", async () => {
  const { productionFactsRows } = await import("./finder-dedup-scenario.fixture.ts");
  const source = new FakeFacebookSupabase();
  for (const [table, rows] of Object.entries(productionFactsRows())) source.seed(table, rows);
  const snapshot = structuredClone(Object.fromEntries(FINDER_READ_TABLES.map((table) => [table, source.rows(table)])));
  const { recorded, record } = createSelectRecorder();
  client = readOnlySupabase(source as unknown as { from: (table: string) => unknown }, record);
  const live = await readBoth({ exportedAt: "", now: "2026-10-13T12:00:00.000Z", filterId: "6ebf3a9c-5418-4ae6-a0bf-1989b6603367", operatorId: "operator-test", cases: [], tables: {}, expected: null });
  const cases = [{ price: 238000, area: 37.07 }, { price: 298000, area: 46.55 }];
  const ids = focusListingIds(live.after, live.pairs, cases);
  assert.deepEqual([...ids].sort(), ["domy-298", "gratka-238", "nol-238", "oferty-298", "olx-238", "olx-298", "other-238", "otodom-238"], "the export holds the seven Production listings and every other flat with the same price and area, so the report shows why it stays apart");
  const fixture = buildDedupFixture({ recorded, ids, filterId: "6ebf3a9c-5418-4ae6-a0bf-1989b6603367", operatorId: "operator-test", now: Date.parse("2026-10-13T12:00:00.000Z"), cases });
  assert.deepEqual(Object.fromEntries(FINDER_READ_TABLES.map((table) => [table, source.rows(table)])), snapshot, "recording never changes the source");

  client = replayClient(fixture).client;
  const replay = await readBoth(fixture);
  const shape = (payload: typeof replay.after) => [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults]
    .filter((card) => (card.linkedListings ?? [{ id: card.id }]).some((item) => ids.has(item.id)))
    .map((card) => ({ members: (card.linkedListings ?? [{ id: card.id }]).map((item) => item.id).sort(), candidates: (card.identityCandidates ?? []).map((item) => item.id).sort() }))
    .sort((a, b) => a.members[0].localeCompare(b.members[0]));
  assert.deepEqual(shape(replay.after), shape(live.after));
  const report = buildDedupReport({ ...replay, cases, listingRows: new Map((fixture.tables.listings ?? []).map((row) => [String(row.id), row])) });
  assert.match(report, /## 238 000 zł \/ 37,07 m²/u);
  assert.match(report, /MOŻLIWY DUPLIKAT/u);
});

test("Production replay (faithful export of the seven listings): every copy is shown once, no unexplained split, no automatic link without content evidence", { skip: existsSync(PRODUCTION_FIXTURE) ? false : "brak eksportu z Production — uruchom scripts/finder-dedup-diagnostics.mts --export" }, async () => {
  const fixture = JSON.parse(readFileSync(PRODUCTION_FIXTURE, "utf8")) as DedupFixture;
  const replay = replayClient(fixture);
  client = replay.client;
  const before = structuredClone(Object.fromEntries(FINDER_READ_TABLES.map((table) => [table, replay.fake.rows(table)])));
  const { after, pairs } = await readBoth(fixture);
  const cards = [...after.results, ...after.reviewResults, ...after.buildingVerificationResults];
  const exported = new Set((fixture.tables.listings ?? []).map((row) => String(row.id)));
  const shown = cards.flatMap((card) => (card.linkedListings ?? [{ id: card.id }]).map((item) => item.id)).filter((id) => exported.has(id));
  assert.equal(new Set(shown).size, shown.length, "no listing is shown twice");
  // Two copies with the same price and exact area are either one card or a possible duplicate of each other — never silently apart.
  const cardOf = new Map(cards.flatMap((card) => (card.linkedListings ?? [{ id: card.id }]).map((item) => [item.id, card] as const)));
  for (const pair of pairs) {
    if (!pair.evidence.includes("exact_area") || !pair.evidence.includes("price_equal") || pair.conflicts.length || pair.blocked) continue;
    const left = cardOf.get(pair.leftId);
    const right = cardOf.get(pair.rightId);
    if (!left || !right || left === right) continue;
    const offered = (left.identityCandidates ?? []).some((item) => item.id === pair.rightId) || (right.identityCandidates ?? []).some((item) => item.id === pair.leftId)
      || (left.identityCandidates ?? []).some((item) => (right.linkedListings ?? []).some((member) => member.id === item.id))
      || (right.identityCandidates ?? []).some((item) => (left.linkedListings ?? []).some((member) => member.id === item.id));
    assert.ok(offered, `${pair.leftId} / ${pair.rightId}: same price and area on separate cards must be offered as a possible duplicate`);
  }
  for (const pair of pairs.filter((item) => item.kind === "confirmed" && item.reason === "cross_portal_multi_evidence")) {
    assert.ok(pair.evidence.some((item) => ["description", "photos", "offer_reference", "street"].includes(item)), `${pair.leftId} / ${pair.rightId} linked without strong evidence`);
  }
  if (fixture.expected) {
    const groups = cards.map((card) => (card.linkedListings ?? [{ id: card.id }]).map((item) => item.id).filter((id) => exported.has(id)).sort()).filter((group) => group.length).sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(groups, fixture.expected.groups.map((group) => [...group].sort()).sort((a, b) => a[0].localeCompare(b[0])), "grouping confirmed by a person");
  }
  assert.deepEqual(Object.fromEntries(FINDER_READ_TABLES.map((table) => [table, replay.fake.rows(table)])), before, "the replay never changes data");
});
