import assert from "node:assert/strict";
import test from "node:test";
import { assessListingIdentityPair, extractListingIdentityEvidence, normalizeListingIdentityEvidence, normalizeSharedPhotoAssetKey } from "./identity-evidence.ts";
import { groupPropertyResults } from "./property-identity.ts";

function listing(id: string, source: "gratka" | "morizon" | "domiporta", identityEvidence: ReturnType<typeof extractListingIdentityEvidence>, overrides: Record<string, unknown> = {}) {
  return { id, source, title: "Mieszkanie", price: 300_000, area: identityEvidence.area, rooms: identityEvidence.rooms, originalUrl: `https://${source}.pl/oferta/${id}`, publishedAt: "2026-10-01", firstSeenAt: "2026-10-01", lastSeenAt: "2026-10-08", crossSourceIdentity: null, identityEvidence, decisionBucket: "MATCHED" as const, lifecycleStatus: "ACTIVE" as const, manualDecision: null, isNew: false, matchReasons: [], unknownFields: [], ...overrides };
}

test("same broker offer reference is trusted only when namespaced by a parsed agency context", () => {
  const raw = { seller: { "@type": "RealEstateAgent", name: "Biuro Łódź", additionalProperty: [{ name: "Numer oferty", value: "AB-123" }] }, additionalProperty: [{ name: "Nr oferty", value: "AB-123" }] };
  const left = extractListingIdentityEvidence({ source: "gratka", area: 52, rooms: 2, sourceRecord: raw });
  const same = extractListingIdentityEvidence({ source: "morizon", area: 52.2, rooms: 2, sourceRecord: structuredClone(raw) });
  const otherAgency = extractListingIdentityEvidence({ source: "domiporta", area: 52.2, rooms: 2, sourceRecord: { ...structuredClone(raw), seller: { name: "Inne Biuro", additionalProperty: [{ name: "Numer oferty", value: "AB-123" }] } } });
  assert.deepEqual(left.agencyReference, { agency: "biuro-lodz", number: "ab-123" });
  assert.equal(assessListingIdentityPair(left, same).kind, "confirmed");
  assert.equal(assessListingIdentityPair(left, otherAgency).kind, "separate", "identical number at another agency is a hard conflict, not a shared ID");
  const unscoped = extractListingIdentityEvidence({ source: "gratka", sourceRecord: { agencyName: "Biuro Łódź", agencyOfferNumber: "AB-123" } });
  assert.equal(unscoped.agencyReference, null, "raw agencyName and a number without parsed seller/provider context are not trusted");
});

test("exact unit address plus compatible independent area, room and market facts confirms a unit despite price changes", () => {
  const evidence = (source: "gratka" | "morizon", area: number, price: number) => extractListingIdentityEvidence({ source, address: { streetAddress: "ul. Tuwima 12/4", addressLocality: "Łódź" }, city: "Łódź", area, rooms: 3, marketType: "secondary", buildingType: "kamienica", sourceRecord: { address: { streetAddress: "ul. Tuwima 12/4", addressLocality: "Łódź" }, marketType: "secondary", offers: { price } } });
  const left = evidence("gratka", 71, 365000);
  const right = evidence("morizon", 71.5, 389000);
  assert.equal(left.unitKey, "lodz|tuwima|12|unit:4");
  assert.equal(assessListingIdentityPair(left, right).kind, "confirmed");
  const otherUnit = extractListingIdentityEvidence({ source: "morizon", address: { streetAddress: "Tuwima 12/5", addressLocality: "Łódź" }, city: "Łódź", area: 71, rooms: 3, marketType: "secondary", buildingType: "kamienica" });
  assert.equal(assessListingIdentityPair(left, otherUnit).kind, "separate", "different unit number blocks same-building matching");
});

test("string addresses retain the parsed city so matching street/unit numbers in different cities never merge", () => {
  const łódź = extractListingIdentityEvidence({ source: "otodom", address: "ul. Tuwima 12/4", city: "Łódź", area: 50, rooms: 2, marketType: "secondary" });
  const poznań = extractListingIdentityEvidence({ source: "olx", address: "ul. Tuwima 12/4", city: "Poznań", area: 50, rooms: 2, marketType: "secondary" });
  assert.equal(łódź.buildingKey, "lodz|tuwima|12");
  assert.equal(poznań.buildingKey, "poznan|tuwima|12");
  assert.equal(assessListingIdentityPair(łódź, poznań).kind, "separate");
});

test("image transform query variants only create a review candidate with same building and independent compatible details", () => {
  const base = extractListingIdentityEvidence({ source: "gratka", address: { streetAddress: "Tuwima 12", addressLocality: "Łódź" }, area: 50, rooms: 2, images: ["https://cdn.example/inside-1.jpg?w=300", "https://cdn.example/inside-2.jpg?watermark=logo&quality=70"] });
  const other = extractListingIdentityEvidence({ source: "morizon", address: { streetAddress: "Tuwima 12", addressLocality: "Łódź" }, area: 50.2, rooms: 2, images: ["https://cdn.example/inside-1.jpg?w=1600", "https://cdn.example/inside-2.jpg?watermark=other&quality=95"] });
  assert.equal(normalizeSharedPhotoAssetKey("https://cdn.example/a.jpg?w=320&watermark=1"), "https://cdn.example/a.jpg");
  assert.equal(assessListingIdentityPair(base, other).kind, "candidate", "even two image matches never automatically confirm identity");
  assert.equal(assessListingIdentityPair(base, other, { blocked: true }).kind, "separate");
  const single = { ...other, sharedPhotoAssetKeys: other.sharedPhotoAssetKeys.slice(0, 1) };
  assert.equal(assessListingIdentityPair(base, single).kind, "separate", "a single common photo cannot create a candidate");
});

test("auto grouping checks every pair, emits candidates, obeys durable not_link, and never single-link chains", () => {
  const make = (id: string, area: number, overrides: Record<string, unknown> = {}) => listing(id, id === "a" ? "gratka" : id === "b" ? "morizon" : "domiporta", {
    agencyReference: null, buildingKey: "lodz|tuwima|12", apartmentNumber: "4", unitKey: "lodz|tuwima|12|unit:4", marketType: "secondary", buildingType: "kamienica", area, rooms: 2, floor: "3", sharedPhotoAssetKeys: [],
  }, overrides);
  const a = make("a", 50);
  const b = make("b", 50.5);
  const c = make("c", 51);
  const grouped = groupPropertyResults([a, b, c]);
  assert.equal(grouped.length, 2, "A-B and B-C each fit rounding tolerance, but A-C conflicts so no three-node chain forms");
  assert.deepEqual(grouped.map((group) => group.linkedListings.length).sort(), [1, 2]);
  const blocked = groupPropertyResults([a, b], { blockedPairs: new Set(["a|b"]) });
  assert.equal(blocked.length, 2, "operator not_link survives later evidence import");
  const photos = (id: string, source: "gratka" | "morizon") => listing(id, source, { agencyReference: null, buildingKey: "lodz|tuwima|12", apartmentNumber: null, unitKey: null, marketType: "secondary", buildingType: "kamienica", area: 50, rooms: 2, floor: null, sharedPhotoAssetKeys: ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg"] });
  const [candidateGroup] = groupPropertyResults([photos("p1", "gratka"), photos("p2", "morizon")]);
  assert.equal(candidateGroup.linkedListings.length, 1);
  assert.equal(candidateGroup.identityCandidates.length, 1);
  const manuallyGrouped = groupPropertyResults([a, b], { manualGroupByListing: new Map([["a", "finder-group"], ["b", "finder-group"]]) });
  assert.equal(manuallyGrouped.length, 1);
  assert.equal(manuallyGrouped[0].identityGroupId, "finder-group", "manual grouping is explicit in Finder result scope");
});

test("a partial manual group is not silently rebuilt by auto-linking, and candidate evidence from any group member remains visible", () => {
  const evidence = (photos: string[]) => ({
    agencyReference: { agency: "biuro-a", number: "same-offer" },
    buildingKey: "lodz|tuwima|12",
    apartmentNumber: null,
    unitKey: null,
    marketType: "secondary" as const,
    buildingType: "kamienica",
    area: 50,
    rooms: 2,
    floor: null,
    sharedPhotoAssetKeys: photos,
  });
  const first = listing("a", "gratka", evidence(["https://cdn.example/a.jpg"]));
  const second = listing("b", "morizon", evidence(["https://cdn.example/b1.jpg", "https://cdn.example/b2.jpg"]));
  const candidate = listing("c", "domiporta", { ...evidence(["https://cdn.example/b1.jpg", "https://cdn.example/b2.jpg"]), agencyReference: null });

  const [confirmedGroup] = groupPropertyResults([first, second, candidate]);
  assert.deepEqual(confirmedGroup.linkedListings.map((member) => member.id).sort(), ["a", "b"]);
  assert.equal(confirmedGroup.identityCandidates[0]?.id, "c", "a review candidate found from a non-representative member is still shown on the group card");

  const partial = groupPropertyResults([first, second], { manualGroupByListing: new Map([["a", "persisted-group"]]) });
  assert.equal(partial.length, 2, "a partially visible manual group member is not automatically linked to an unrelated result");
  assert.ok(partial.every((group) => group.identityGroupId === null), "an incomplete persisted group is not misrepresented as a visible confirmed group");
});

test("evidence JSON normalization fails closed and ignores unsafe photo URLs", () => {
  assert.equal(normalizeListingIdentityEvidence({ buildingKey: "fake", sharedPhotoAssetKeys: ["http://unsafe/a.jpg"] }).sharedPhotoAssetKeys.length, 0);
  assert.equal(normalizeSharedPhotoAssetKey("https://user:pass@cdn.example/photo.jpg"), null);
});
