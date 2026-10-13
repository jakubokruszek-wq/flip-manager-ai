import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeFacebookSupabase } from "../../facebook-watcher/server/facebook-fake-supabase.ts";
import { FILTER_ID, NOW, PRODUCTION_PARAMETERS, productionFactsRows, productionScenarioRows } from "./finder-dedup-scenario.fixture.ts";
import type { IdentityPairDiagnostic } from "../property-identity.ts";

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

async function readCards(db: FakeFacebookSupabase) {
  resetFinderReadCachesForTests();
  currentDb = db;
  const pairs: IdentityPairDiagnostic[] = [];
  const payload = await getFilterResults(FILTER_ID, false, NOW, "operator-test", { identity: { onPairAssessed: (pair) => pairs.push(pair) } });
  assert.ok(payload);
  const all = [...payload.results, ...payload.reviewResults, ...payload.buildingVerificationResults];
  const cardOf = (id: string) => all.find((card) => (card.linkedListings ?? [{ id: card.id }]).some((item) => item.id === id));
  const membersOf = (id: string) => (cardOf(id)?.linkedListings ?? []).map((item) => item.id).sort();
  const candidateIds = (id: string) => (cardOf(id)?.identityCandidates ?? []).map((candidate) => candidate.id).sort();
  const pair = (a: string, b: string) => pairs.find((item) => [item.leftId, item.rightId].sort().join("|") === [a, b].sort().join("|"));
  return { payload, all, cardOf, membersOf, candidateIds, pair };
}

test("production parameters are reproduced exactly (lengths, floors, photo counts) and nothing else is invented", () => {
  const rows = productionFactsRows().listings;
  for (const row of rows) {
    const facts = PRODUCTION_PARAMETERS[row.id as keyof typeof PRODUCTION_PARAMETERS];
    assert.equal((row.description as string).length, facts.descriptionLength, `${row.id as string} description length`);
    assert.equal(row.floor, facts.floor);
    if (facts.photos !== null) assert.equal((row.images as string[]).length, facts.photos);
    assert.equal(row.rooms, null, "rooms were not reported");
    assert.equal(row.title, null, "titles were not reported");
    assert.equal(row.district, null, "districts were not reported");
  }
  assert.equal(rows.length, 7);
});

test("production parameters, unknown fields left unknown: no automatic link (score below the unchanged threshold), every copy offered as a possible duplicate", async () => {
  const { all, membersOf, candidateIds, pair } = await readCards(productionDb7());
  assert.equal(all.length, 7, "7 cards before and after: nothing is linked automatically without enough evidence");
  for (const id of Object.keys(PRODUCTION_PARAMETERS)) assert.deepEqual(membersOf(id), [id]);
  // 238 000: the shared description is strong, but area + price + description = 6 points < 7 (threshold not lowered).
  const olxGratka = pair("olx-238", "gratka-238");
  assert.equal(olxGratka?.kind, "candidate");
  assert.equal(olxGratka?.score, 6);
  assert.deepEqual(olxGratka?.evidence, ["exact_area", "price_equal", "description"]);
  assert.equal(pair("gratka-238", "nol-238")?.kind, "candidate");
  // floor_4 (OLX) and FOURTH (Otodom) are the same floor.
  assert.deepEqual(pair("olx-238", "otodom-238")?.evidence, ["exact_area", "price_equal", "floor"]);
  assert.deepEqual(candidateIds("otodom-238"), ["gratka-238", "nol-238", "olx-238"]);
  assert.deepEqual(candidateIds("olx-238"), ["gratka-238", "nol-238", "otodom-238"]);
  // 298 000: only area and price agree.
  assert.deepEqual(pair("olx-298", "domy-298")?.evidence, ["exact_area", "price_equal"]);
  for (const id of ["olx-298", "domy-298", "oferty-298"]) assert.equal(candidateIds(id).length, 2, `${id} lists both other copies`);
  assert.ok(!candidateIds("olx-238").some((id) => id.endsWith("298")), "different flats are never offered");
});

test("production parameters with the hypothesis that every portal states 2 rooms: still no automatic link — the description is the only location/content evidence (3 < 3.5)", async () => {
  const { all, membersOf, candidateIds, pair } = await readCards(productionDb7({ assumeRooms: 2 }));
  const olxGratka = pair("olx-238", "gratka-238");
  assert.equal(olxGratka?.kind, "candidate");
  assert.equal(olxGratka?.score, 7, "enough points…");
  assert.deepEqual(olxGratka?.evidence, ["exact_area", "rooms", "price_equal", "description"], "…but no floor, street, district, title or photo agrees, so corroboration stays at 3");
  assert.deepEqual(membersOf("olx-238"), ["olx-238"]);
  assert.deepEqual(candidateIds("olx-238"), ["gratka-238", "nol-238", "otodom-238"]);
  for (const id of ["olx-298", "domy-298", "oferty-298"]) assert.equal(candidateIds(id).length, 2);
  assert.equal(all.length, 7);
});

function productionDb7(options: { assumeRooms?: number } = {}): FakeFacebookSupabase {
  const db = new FakeFacebookSupabase();
  for (const [table, rows] of Object.entries(productionFactsRows(options))) db.seed(table, rows);
  return db;
}

test("„Wyczyść wyniki” as the UI sends it (no scope, through the API route) hides cards only: no listing, photo, price snapshot or membership is deleted and the offers stay in the history", async () => {
  resetFinderReadCachesForTests();
  currentDb = productionDb7();
  const before = structuredClone({ listings: currentDb.rows("listings"), snapshots: currentDb.rows("listing_snapshots"), memberships: currentDb.rows("listing_filter_matches") });
  const { POST } = await import("../../../app/api/flip-finder/search-filters/[id]/clear-results/route.ts");
  const response = await POST(new Request(`http://localhost/api/flip-finder/search-filters/${FILTER_ID}/clear-results`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id: FILTER_ID }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { archivedCount: number; bySource: Record<string, number> };
  assert.equal(body.archivedCount, 7);
  assert.deepEqual(body.bySource, { olx: 2, gratka: 1, nieruchomosci_online: 1, otodom: 1, domy: 1, oferty_net: 1 });
  assert.deepEqual(currentDb.rows("listings"), before.listings, "listings (including photos and descriptions) are unchanged");
  assert.deepEqual(currentDb.rows("listing_snapshots"), before.snapshots, "price history is unchanged");
  assert.equal(currentDb.rows("listing_filter_matches").length, before.memberships.length, "no membership row is deleted");
  assert.ok(currentDb.rows("listing_filter_matches").every((row) => row.is_current_match === false && (row.match_reasons as string[]).includes("finder_cleared")), "memberships are only marked as cleared");
  resetFinderReadCachesForTests();
  const archive = await getFilterResults(FILTER_ID, false, NOW, "operator-test", { view: "archive" });
  assert.equal(archive?.archive?.total, 7, "every cleared offer is still listed in the history");
});
