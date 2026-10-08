import assert from "node:assert/strict";
import test from "node:test";
import { groupConfirmedPropertyResults, normalizeConfirmedPropertyIdentity } from "./property-identity.ts";

function result(id: string, source: "gratka" | "morizon" | "nieruchomosci_online", overrides: Record<string, unknown> = {}) {
  return { id, source, title: "Mieszkanie", price: 365_000, area: 71, rooms: 3, originalUrl: `https://${source}.example/${id}`, publishedAt: "2026-10-01T00:00:00.000Z", firstSeenAt: "2026-10-01T00:00:00.000Z", lastSeenAt: "2026-10-08T00:00:00.000Z", crossSourceIdentity: "portal_shared_unit_id:unit-71", decisionBucket: "MATCHED" as const, lifecycleStatus: "ACTIVE" as const, manualDecision: null, isNew: false, matchReasons: [], unknownFields: [], ...overrides };
}

test("only explicit, namespaced stable unit references qualify as cross-source identities", () => {
  assert.equal(normalizeConfirmedPropertyIdentity("portal_shared_unit_id:unit-1"), "portal_shared_unit_id:unit-1");
  for (const weak of ["365000:71:3:Widzew", "content_hash:abc", "address:ul-tuwima", "title:identical"]) assert.equal(normalizeConfirmedPropertyIdentity(weak), null);
  const sourcePayload = { crossSourceIdentityKind: "canonical_unit_id", crossSourceIdentity: "untrusted-portal-value" };
  const fromPayloadOnly = result("payload-only", "gratka", { rawPayload: sourcePayload, crossSourceIdentity: null });
  assert.equal(groupConfirmedPropertyResults([fromPayloadOnly])[0].crossSourceIdentity, null, "untrusted source JSON cannot establish identity by naming a property");
});

test("three confirmed portal copies produce one deterministic card with separate source rows and links", () => {
  const members = [result("c", "nieruchomosci_online"), result("b", "morizon"), result("a", "gratka")];
  const group = groupConfirmedPropertyResults(members);
  const reversed = groupConfirmedPropertyResults([...members].reverse());
  assert.equal(group.length, 1);
  assert.equal(group[0].id, "a", "stable source/id tiebreak makes selection independent of import order");
  assert.deepEqual(group[0].linkedListings.map((item) => item.source).sort(), ["gratka", "morizon", "nieruchomosci_online"]);
  assert.deepEqual(group[0].linkedListings.map((item) => item.originalUrl).sort(), members.map((item) => item.originalUrl).sort());
  assert.equal(reversed[0].id, group[0].id);
  assert.equal(group[0].price, 365_000);
  assert.equal(group[0].area, 71, "representative's price and area remain from the same row");
});

test("same parameters and similar URLs do not merge two different units without confirmed identity", () => {
  const left = result("left", "gratka", { crossSourceIdentity: null });
  const right = result("right", "morizon", { crossSourceIdentity: null });
  assert.equal(groupConfirmedPropertyResults([left, right]).length, 2);
  const weakKey = result("weak", "gratka", { crossSourceIdentity: "content_hash:same-title-price-area" });
  assert.equal(groupConfirmedPropertyResults([left, weakKey]).length, 2);
});

test("two records carrying the same confirmed canonical unit reference count as one property even on one source", () => {
  const first = result("same-portal-a", "gratka", { crossSourceIdentity: "canonical_unit_id:real-unit" });
  const second = result("same-portal-b", "gratka", { crossSourceIdentity: "canonical_unit_id:real-unit" });
  const grouped = groupConfirmedPropertyResults([first, second]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].linkedListings.length, 2);
});

test("a confirmed group appears in only one bucket; REVIEW wins over MATCHED and manual rejection hides the group", () => {
  const matched = result("a", "gratka");
  const review = result("b", "morizon", { decisionBucket: "REVIEW", lifecycleStatus: "REVIEW", unknownFields: ["floor"] });
  const groupedReview = groupConfirmedPropertyResults([matched, review]);
  assert.equal(groupedReview.length, 1);
  assert.equal(groupedReview[0].decisionBucket, "REVIEW");
  assert.deepEqual(groupedReview[0].unknownFields, ["floor"]);
  const rejected = groupConfirmedPropertyResults([matched, { ...review, manualDecision: "REJECTED" as const, lifecycleStatus: "REJECTED" as const }]);
  assert.equal(rejected[0].decisionBucket, "REJECTED");
});
