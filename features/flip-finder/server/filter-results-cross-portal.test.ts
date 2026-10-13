import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { DOMY_298_SHORT, FILTER_ID, NOW, OFERTY_298_SHORT, productionFactsRows, productionScenarioRows } from "./finder-dedup-scenario.fixture.ts";

/**
 * Production 13.10.2026: the same flats were shown as separate cards in
 * Dopasowane and Do oceny (238 000 zł / 37,07 m² on OLX, Otodom, Gratka and
 * Nieruchomości-online; 298 000 zł / 46,55 m² on OLX, Domy.pl, Oferty.net).
 * Driven through the real Finder read path; it never writes to the database.
 *
 * The first scenario is synthetic (full agency descriptions on every
 * portal). The second mirrors the facts read from Production on 13.10:
 * Otodom has an empty description, Domy.pl 56 characters and Oferty.net 91
 * characters, so the description cannot corroborate those copies. The exact
 * Production rows are replayed by filter-results-production-replay.test.ts
 * once exported with scripts/finder-dedup-diagnostics.mts.
 */
function productionDb(overrides: Record<string, Record<string, unknown>> = {}): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  for (const [table, rows] of Object.entries(productionScenarioRows(overrides))) db.seed(table, rows);
  return db;
}

function productionFactsDb(): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  for (const [table, rows] of Object.entries(productionFactsRows())) db.seed(table, rows);
  return db;
}

let currentDb = productionDb();
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => currentDb } });
mock.module("@/lib/supabase/admin", { namedExports: { createAdminClient: () => currentDb } });
mock.module("@/features/auth/operator", { namedExports: { requireOperator: async () => ({ id: "operator-test", email: "o@example.test" }), operatorAuthorizationResponse: () => Response.json({}, { status: 401 }) } });
const { getFilterResults, resetFinderReadCachesForTests } = await import("./filter-results.ts");

test("Production duplicates: each flat is one card in Dopasowane with every portal link, and no copy remains in Do oceny", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb();
  const before = structuredClone({ listings: currentDb.rows("listings"), memberships: currentDb.rows("listing_filter_matches"), snapshots: currentDb.rows("listing_snapshots") });
  const payload = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  assert.ok(payload);
  const cards = new Map(payload.results.map((card) => [card.price, card]));
  const card238 = payload.results.find((card) => card.linkedListings?.some((item) => item.id === "olx-238"));
  const card298 = payload.results.find((card) => card.linkedListings?.some((item) => item.id === "olx-298"));
  assert.deepEqual(card238?.linkedListings?.map((item) => item.source).sort(), ["gratka", "nieruchomosci_online", "olx", "otodom"]);
  assert.deepEqual(card298?.linkedListings?.map((item) => item.source).sort(), ["domy", "oferty_net", "olx"], "the Oferty.net copy without a structured room count is linked through its text, exact area and description");
  assert.ok(card238?.linkedListings?.every((item) => item.originalUrl?.startsWith("https://")), "all source links are kept");
  const visibleIds = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults].map((card) => card.id);
  assert.equal(payload.reviewResults.length + payload.buildingVerificationResults.length, 0, "no REVIEW card for a copy of a MATCHED flat");
  assert.equal(new Set(visibleIds).size, visibleIds.length);
  assert.ok(payload.results.some((card) => card.id === "other-238" && (card.linkedListings?.length ?? 1) === 1), "a different flat with the same price and area stays its own card");
  assert.equal(cards.size, 2, "two price points: 238 000 (two different flats) and 298 000");
  assert.equal(payload.results.length, 3);
  assert.equal(payload.counts.active, 3);
  assert.equal(payload.counts.review + payload.counts.buildingVerification, 0);
  assert.deepEqual({ listings: currentDb.rows("listings"), memberships: currentDb.rows("listing_filter_matches"), snapshots: currentDb.rows("listing_snapshots") }, before, "the read never changes listings, decisions or price history");
});

test("an operator's 'do not link' decision splits a confirmed copy back into its own card without touching data", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb().seed("finder_listing_identity_decisions", [{ owner_id: "operator-test", search_filter_id: FILTER_ID, listing_a: "domy-298", listing_b: "olx-298", decision: "not_link" }]);
  const payload = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  const card298 = payload?.results.find((card) => card.linkedListings?.some((item) => item.id === "olx-298"));
  assert.equal(card298?.linkedListings?.some((item) => item.id === "domy-298"), false);
  const all = [...(payload?.results ?? []), ...(payload?.reviewResults ?? []), ...(payload?.buildingVerificationResults ?? [])];
  assert.ok(all.some((card) => card.linkedListings?.some((item) => item.id === "domy-298")), "the split copy is still shown, never lost");
});


test("a source-scoped clear refuses to hide copies from other portals without an explicit confirmation", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb();
  const { clearFilterResults, ClearResultsLinkedCopiesError } = await import("./clear-results.ts");
  const before = structuredClone(currentDb.rows("listing_filter_matches"));
  await assert.rejects(clearFilterResults(FILTER_ID, { source: "olx" }, "operator-test"), (error: unknown) => {
    assert.ok(error instanceof ClearResultsLinkedCopiesError);
    assert.equal(error.linkedCards, 2);
    assert.deepEqual(error.otherSources, { domy: 1, gratka: 1, nieruchomosci_online: 1, oferty_net: 1, otodom: 1 });
    assert.match(error.message, /innych portali .*otodom: 1/u);
    return true;
  });
  assert.deepEqual(currentDb.rows("listing_filter_matches"), before, "nothing is archived when the clear is refused");
});

test("a confirmed clear archives every linked portal copy, so a grouped card does not come back split, and reports each portal", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb();
  const { clearFilterResults } = await import("./clear-results.ts");
  const cleared = await clearFilterResults(FILTER_ID, { source: "olx", includeLinkedCopies: true }, "operator-test");
  assert.equal(cleared.archivedCount, 7, "both OLX-represented cards with all of their linked copies");
  assert.deepEqual(cleared.bySource, { olx: 2, otodom: 1, gratka: 1, nieruchomosci_online: 1, domy: 1, oferty_net: 1 });
  assert.equal(cleared.linkedCopiesFromOtherSources, 5);
  const after = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  assert.deepEqual([...(after?.results ?? []), ...(after?.reviewResults ?? []), ...(after?.buildingVerificationResults ?? [])].map((card) => card.id), ["other-238"]);
  assert.equal(currentDb.rows("listings").length, 8, "no listing is deleted");
});

test("Production facts: an empty or very short description never auto-links a copy; it is offered as a possible duplicate instead", async () => {
  assert.equal(DOMY_298_SHORT.length, 56);
  assert.equal(OFERTY_298_SHORT.length, 91);
  resetFinderReadCachesForTests();
  currentDb = productionFactsDb();
  const payload = await getFilterResults(FILTER_ID, false, NOW, "operator-test");
  assert.ok(payload);
  const all = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults];
  const cardOf = (id: string) => all.find((card) => (card.linkedListings ?? [{ id: card.id }]).some((item) => item.id === id));
  const candidateIds = (id: string) => (cardOf(id)?.identityCandidates ?? []).map((candidate) => candidate.id).sort();

  // 238 000 zł: OLX, Gratka and Nieruchomości-online share the agency description; Otodom has none.
  assert.deepEqual(cardOf("olx-238")?.linkedListings?.map((item) => item.source).sort(), ["gratka", "nieruchomosci_online", "olx"]);
  assert.equal(cardOf("otodom-238")?.linkedListings?.length ?? 1, 1, "the Otodom copy without a description is not linked automatically");
  assert.ok(candidateIds("otodom-238").some((id) => ["olx-238", "gratka-238", "nol-238"].includes(id)), "…but it is shown as a possible duplicate of the grouped card");
  assert.ok(candidateIds("olx-238").includes("otodom-238"), "and the grouped card points back to it");

  // 298 000 zł: no shared description, photo, address or offer number, so nothing links automatically.
  for (const id of ["olx-298", "domy-298", "oferty-298"]) {
    assert.equal(cardOf(id)?.linkedListings?.length ?? 1, 1, `${id} stays its own card`);
    assert.equal(candidateIds(id).length, 2, `${id} lists both other portal copies for a manual decision`);
  }
  // The flat on Retkinia with the same price and area is contradicted (district, floor) and never offered.
  assert.ok(!all.some((card) => card.id !== "other-238" && (card.identityCandidates ?? []).some((candidate) => candidate.id === "other-238")));
  assert.equal(new Set(all.map((card) => card.id)).size, all.length, "every listing is shown exactly once");
  assert.equal(all.reduce((sum, card) => sum + (card.linkedListings?.length ?? 1), 0), 8, "no listing disappears");
});
