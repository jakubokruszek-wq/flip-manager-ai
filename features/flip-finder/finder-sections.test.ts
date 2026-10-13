import assert from "node:assert/strict";
import test from "node:test";
import { partitionFinderRows, sectionForDecision, type FinderRow } from "./finder-sections.ts";
import type { SearchFilter } from "./index.ts";

const filter = {
  id: "f", name: "Flip", sources: ["otodom", "olx"], city: "Łódź", districts: [], priceMin: null, priceMax: null, areaMin: 31, areaMax: 75,
  rooms: [1, 2, 3, 4], floorMin: null, floorMax: null, excludeGroundFloor: false, excludeTopFloor: false, buildingTypes: ["blok", "apartamentowiec"],
  ownershipTypes: [], marketType: null, privateOnly: false, maxPricePerSqm: 6500, requiredKeywords: [], excludedKeywords: [], minFlipScore: null,
  minEstimatedProfit: null, maxEstimatedRenovationCost: null, scanIntervalMinutes: 60, isActive: true, lastScannedAt: null, createdAt: "", updatedAt: "",
} as unknown as SearchFilter;

function row(id: string, section: FinderRow["finderSection"], overrides: Partial<FinderRow> = {}): FinderRow {
  return {
    id, title: `Oferta ${id}`, price: 269000, area: 47, rooms: 2, floor: "1", totalFloors: null, buildingType: "blok", ownership: null,
    description: null, images: [], pricePerSqm: 5700, locationText: null, address: null, city: "Łódź", district: null, thumbnailUrl: null,
    originalUrl: `https://www.otodom.pl/pl/oferta/${id}`, source: "otodom", listingStatus: "active", isActive: true,
    firstSeenAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-12T00:00:00Z", firstMatchedAt: "2026-10-01T00:00:00Z", lastMatchedAt: "2026-10-12T00:00:00Z",
    previousPrice: null, currentPrice: 269000, isNew: false, hasPriceDrop: false, priceDropAmount: null, matchReasons: [], unknownFields: [],
    decisionBucket: section === "MATCHED" ? "MATCHED" : section === "EXCLUDED" ? "REJECTED" : "REVIEW",
    lifecycleStatus: "ACTIVE", finderSection: section,
    buildingQualification: section === "BUILDING_VERIFICATION" ? { status: "needs_verification", type: null, reason: "building_type_unknown", source: null } : { status: "confirmed", type: "blok", reason: "building_type_confirmed_structured", source: "structured" },
    ...overrides,
  };
}

const identityOf = (item: FinderRow) => ({ listingId: item.id, source: item.source, externalListingId: null, originalUrl: item.originalUrl, sourcePostUrl: null });

function placements(partition: ReturnType<typeof partitionFinderRows>): Map<string, string[]> {
  const places = new Map<string, string[]>();
  const add = (id: string, where: string) => places.set(id, [...(places.get(id) ?? []), where]);
  for (const [name, list] of [["matched", partition.matched], ["review", partition.review], ["building", partition.buildingVerification]] as const) {
    for (const card of list) for (const member of card.linkedListings?.length ? card.linkedListings : [card]) add(member.id, name);
  }
  for (const entry of partition.excluded) add(entry.id, `excluded:${entry.code}`);
  return places;
}

test("sections follow the read-time decision: unknown building type goes to its own queue, never to Do oceny", () => {
  assert.equal(sectionForDecision("MATCHED", []), "MATCHED");
  assert.equal(sectionForDecision("REVIEW", ["ownership"]), "REVIEW");
  assert.equal(sectionForDecision("REVIEW", ["buildingType", "ownership"]), "BUILDING_VERIFICATION");
  assert.equal(sectionForDecision("REJECTED", []), "EXCLUDED");
});

test("a MATCHED copy of an ad is never hidden behind a REVIEW duplicate of the same URL (dedupe prefers the best section)", () => {
  const url = "https://www.otodom.pl/pl/oferta/269k";
  // The REVIEW copy has a photo and is newer -- the old quality-only ordering picked it.
  const review = row("b-review", "REVIEW", { originalUrl: url, images: ["https://img/1.jpg"], lastSeenAt: "2026-10-13T00:00:00Z", unknownFields: ["ownership"] });
  const matched = row("a-matched", "MATCHED", { originalUrl: url });
  const partition = partitionFinderRows([review, matched], { filter, identityOf });
  assert.deepEqual(partition.matched.map((card) => card.id), ["a-matched"]);
  assert.deepEqual(partition.review, []);
  assert.deepEqual(partition.excluded.map((entry) => [entry.id, entry.code]), [["b-review", "duplicate"]], "the dropped copy is reported, not silently lost");
});

test("a confirmed cross-portal group is MATCHED when any member matches and is represented by the matching copy", () => {
  const identity = "portal_shared_unit_id:unit-269k";
  const matched = row("olx-269", "MATCHED", { source: "olx", originalUrl: "https://www.olx.pl/d/oferta/269", crossSourceIdentity: identity, price: 269000 });
  const review = row("oto-279", "REVIEW", { crossSourceIdentity: identity, price: 279000, unknownFields: ["rooms"] });
  const partition = partitionFinderRows([review, matched], { filter, identityOf });
  assert.equal(partition.matched.length, 1);
  assert.equal(partition.matched[0].id, "olx-269");
  assert.equal(partition.matched[0].price, 269000, "the representative carries the price that satisfies the filter");
  assert.equal(partition.review.length, 0);
});

test("a tenement label on another portal never hides a correctly described block: the property waits for building verification", () => {
  const identity = "portal_shared_unit_id:unit-conflict";
  const mislabelled = row("oto-tenement", "EXCLUDED", { crossSourceIdentity: identity, exclusion: { code: "filter_rejected", reasons: ["building_type"] }, buildingType: "kamienica", buildingQualification: { status: "rejected", type: "kamienica", reason: "building_type", source: "structured" } });
  const block = row("olx-block", "MATCHED", { source: "olx", originalUrl: "https://www.olx.pl/d/oferta/x", crossSourceIdentity: identity });
  const partition = partitionFinderRows([mislabelled, block], { filter, identityOf });
  assert.equal(partition.matched.length, 0, "an unresolved tenement claim never reaches Dopasowane");
  assert.deepEqual(partition.buildingVerification.map((card) => card.id), ["olx-block"], "the block stays visible, waiting for the operator");
  assert.equal(partition.buildingVerification[0].buildingQualification?.reason, "building_type_cross_portal_conflict");
  assert.deepEqual(partition.excluded.map((entry) => [entry.id, entry.code]), [["oto-tenement", "filter_rejected"]]);
});

test("an operator-confirmed block settles a cross-portal conflict; an operator rejection excludes every copy", () => {
  const identity = "portal_shared_unit_id:unit-operator";
  const mislabelled = row("oto-tenement", "EXCLUDED", { crossSourceIdentity: identity, exclusion: { code: "filter_rejected", reasons: ["building_type"] }, buildingQualification: { status: "rejected", type: "kamienica", reason: "building_type", source: "structured" } });
  const confirmedBlock = row("olx-block", "MATCHED", { source: "olx", originalUrl: "https://www.olx.pl/d/oferta/y", crossSourceIdentity: identity, buildingQualification: { status: "confirmed", type: "blok", reason: "building_type_confirmed_operator", source: "operator" } });
  const confirmed = partitionFinderRows([mislabelled, confirmedBlock], { filter, identityOf });
  assert.deepEqual(confirmed.matched.map((card) => card.id), ["olx-block"]);

  const manualReject = row("oto-manual", "EXCLUDED", { crossSourceIdentity: identity, exclusion: { code: "manual_rejected", reasons: [] } });
  const block = row("olx-block-2", "MATCHED", { source: "olx", originalUrl: "https://www.olx.pl/d/oferta/z", crossSourceIdentity: identity });
  const rejected = partitionFinderRows([manualReject, block], { filter, identityOf });
  assert.equal(rejected.matched.length + rejected.buildingVerification.length, 0);
  assert.deepEqual(new Map(rejected.excluded.map((entry) => [entry.id, entry.code])), new Map([["oto-manual", "manual_rejected"], ["olx-block-2", "linked_property_rejected"]]));
});

test("property invariant: every input row lands exactly once, in one section or in excluded with a reason", () => {
  let seed = 42;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const sections: FinderRow["finderSection"][] = ["MATCHED", "REVIEW", "BUILDING_VERIFICATION", "EXCLUDED"];
  for (let round = 0; round < 25; round += 1) {
    const rows = Array.from({ length: 80 }, (_, index) => {
      const section = sections[Math.floor(random() * sections.length)];
      const sharedUrl = random() < 0.2 ? `https://www.otodom.pl/pl/oferta/dup-${Math.floor(random() * 5)}` : undefined;
      const identity = random() < 0.15 ? `portal_shared_unit_id:g-${Math.floor(random() * 4)}` : null;
      return row(`r${round}-${index}`, section, {
        ...(sharedUrl ? { originalUrl: sharedUrl } : {}),
        crossSourceIdentity: identity,
        ...(section === "EXCLUDED" ? { exclusion: { code: random() < 0.5 ? "filter_rejected" : "lifecycle_stale", reasons: random() < 0.5 ? ["building_type"] : ["price_max"] } } : {}),
        ...(section === "REVIEW" ? { unknownFields: ["ownership"] } : {}),
        ...(section === "BUILDING_VERIFICATION" ? { unknownFields: ["buildingType"] } : {}),
      });
    });
    const places = placements(partitionFinderRows(rows, { filter, identityOf }));
    for (const input of rows) {
      const where = places.get(input.id) ?? [];
      assert.equal(where.length, 1, `round ${round}: ${input.id} appears ${where.length} times (${where.join(", ")})`);
    }
    assert.equal(places.size, rows.length);
  }
});

for (const size of [5_000, 50_000]) {
  test(`partitioning stays linear and correct for ${size.toLocaleString("en-US")} rows`, () => {
    // Historical memberships are not read by the active view at all; this
    // bounds the in-memory cost even for the archive/worst case.
    const rows = Array.from({ length: size }, (_, index) => row(`row-${index}`, index % 1000 === 0 ? "MATCHED" : index % 3 === 0 ? "REVIEW" : "EXCLUDED", {
      exclusion: { code: "lifecycle_archived", reasons: [] },
      unknownFields: index % 3 === 0 ? ["ownership"] : [],
    }));
    const started = performance.now();
    const partition = partitionFinderRows(rows, { filter, identityOf });
    const elapsed = performance.now() - started;
    assert.equal(partition.matched.length + partition.review.length + partition.excluded.length, size);
    assert.ok(elapsed < (size === 5_000 ? 2_000 : 20_000), `partition took ${elapsed.toFixed(0)} ms`);
  });
}
