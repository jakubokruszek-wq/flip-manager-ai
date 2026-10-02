import assert from "node:assert/strict";
import test from "node:test";
import { canonicalFacebookContentFingerprint, canonicalFacebookIdentity, canonicalFacebookParameterFingerprint, dedupeByListingIdentity } from "./listing-identity.ts";

const facebook = (listingId: string, sourcePostUrl: string | null, externalListingId: string | null, observedAt: string) => ({
  listingId,
  source: "facebook",
  sourcePostUrl,
  externalListingId,
  observedAt,
});

test("same listing ID with multiple metadata rows renders once", () => {
  const records = [
    facebook("listing-1", "https://www.facebook.com/groups/a/posts/2", "post-2", "2026-09-27T12:00:00Z"),
    facebook("listing-1", "https://www.facebook.com/groups/a/posts/1", "post-1", "2026-09-27T11:00:00Z"),
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record), [records[0]]);
});

test("same Facebook source post across listing IDs renders once, newest wins", () => {
  const records = [
    facebook("listing-new", "https://www.facebook.com/groups/a/posts/2", "post-2", "2026-09-27T12:00:00Z"),
    facebook("listing-old", "https://www.facebook.com/groups/a/posts/2", "post-2", "2026-09-27T11:00:00Z"),
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record), [records[0]]);
});

test("same external listing ID is deduped, while distinct identity remains separate", () => {
  const duplicate = [
    facebook("listing-1", null, "ext-1", "2026-09-27T12:00:00Z"),
    facebook("listing-2", null, "ext-1", "2026-09-27T11:00:00Z"),
  ];
  assert.equal(dedupeByListingIdentity(duplicate, (record) => record).length, 1);
  const distinct = [
    facebook("listing-1", null, "ext-1", "2026-09-27T12:00:00Z"),
    facebook("listing-2", null, "ext-2", "2026-09-27T11:00:00Z"),
  ];
  assert.equal(dedupeByListingIdentity(distinct, (record) => record).length, 2);
});

test("tracking and mobile/group route variants resolve to one Facebook post", () => {
  const records = [
    facebook("listing-group", "https://www.facebook.com/groups/one/posts/4486483384955652/?utm_source=feed&ref=share", "facebook:group:one:post:4486483384955652", "2026-09-27T12:00:00Z"),
    facebook("listing-mobile", "https://m.facebook.com/groups/two/posts/4486483384955652", "facebook:group:two:post:4486483384955652", "2026-09-27T11:00:00Z"),
  ];
  assert.equal(dedupeByListingIdentity(records, (record) => record).length, 1);
  assert.equal(canonicalFacebookIdentity(records[0]).postId, "4486483384955652");
});

test("a valid listing URL remains the fallback when source metadata is missing or a placeholder", () => {
  const records = [
    {
      ...facebook("listing-valid", "https://www.facebook.com/flip-manager/manual/placeholder", "legacy-1", "2026-09-27T12:00:00Z"),
      originalUrl: "https://www.facebook.com/groups/a/posts/4486483384955652",
    },
    {
      ...facebook("listing-route", null, "facebook:group:b:post:4486483384955652", "2026-09-27T11:00:00Z"),
      originalUrl: "https://m.facebook.com/groups/b/posts/4486483384955652?utm_source=feed",
    },
  ];
  const canonical = canonicalFacebookIdentity(records[0]);
  assert.equal(canonical.sourcePostUrl, "https://facebook.com/groups/a/posts/4486483384955652");
  assert.equal(dedupeByListingIdentity(records, (record) => record).length, 1);
});

test("identical full-content fingerprints collapse route duplicates for one post, while distinct posts remain separate", () => {
  const fingerprint = canonicalFacebookContentFingerprint({ title: "Mieszkanie", description: "Pełny opis oferty", price: 280000, area: 59.9, rooms: 2, location: "Łódź", imageUrls: ["https://img.example/one.jpg"] });
  const duplicate = [
    { ...facebook("listing-a", "https://www.facebook.com/groups/a/posts/100000000000001", "100000000000001", "2026-09-27T12:00:00Z"), contentFingerprint: fingerprint },
    { ...facebook("listing-b", "https://www.facebook.com/groups/b/posts/100000000000001", "100000000000001", "2026-09-27T11:00:00Z"), contentFingerprint: fingerprint },
  ];
  assert.equal(dedupeByListingIdentity(duplicate, (record) => record).length, 1);

  const distinct = [
    duplicate[0],
    { ...facebook("listing-c", "https://www.facebook.com/groups/c/posts/100000000000002", "100000000000002", "2026-09-27T10:00:00Z"), contentFingerprint: fingerprint },
  ];
  assert.equal(dedupeByListingIdentity(distinct, (record) => record).length, 2);
});

test("parameter fingerprint collapses a repost when gallery/content differs", () => {
  const parameters = canonicalFacebookParameterFingerprint({ title: "Mieszkanie 2 pokoje", price: 280000, area: 59.9, rooms: 2, location: "Bałuty, Łódź" });
  assert.ok(parameters);
  const records = [
    { ...facebook("listing-with-photo", null, null, "2026-09-27T12:00:00Z"), parameterFingerprint: parameters },
    { ...facebook("listing-without-photo", null, null, "2026-09-27T11:00:00Z"), parameterFingerprint: parameters },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record), [records[0]]);
});

test("different Facebook posts stay separate even when visible parameters match", () => {
  const parameters = canonicalFacebookParameterFingerprint({ title: "Mieszkanie", description: "Ten sam opis", price: 280000, area: 59.9, rooms: 2, location: "Bałuty, Łódź" });
  assert.ok(parameters);
  const records = [
    { ...facebook("listing-a", "https://www.facebook.com/groups/a/posts/100000000000001", "100000000000001", "2026-09-27T12:00:00Z"), parameterFingerprint: parameters, contentFingerprint: "a" },
    { ...facebook("listing-b", "https://www.facebook.com/groups/b/posts/100000000000002", "100000000000002", "2026-09-27T11:00:00Z"), parameterFingerprint: parameters, contentFingerprint: "b" },
  ];
  assert.equal(dedupeByListingIdentity(records, (record) => record).length, 2);
});

test("different confirmed post ids stay separate even with identical full fingerprints", () => {
  const parameters = canonicalFacebookParameterFingerprint({ title: "Mieszkanie", description: "Identyczny opis", price: 280000, area: 59.9, rooms: 2, location: "Bałuty, Łódź" });
  assert.ok(parameters);
  const records = [
    { ...facebook("listing-a", "https://www.facebook.com/groups/a/posts/100000000000001", "100000000000001", "2026-09-27T12:00:00Z"), parameterFingerprint: parameters, contentFingerprint: "same-full-content" },
    { ...facebook("listing-b", "https://www.facebook.com/groups/b/posts/100000000000002", "100000000000002", "2026-09-27T11:00:00Z"), parameterFingerprint: parameters, contentFingerprint: "same-full-content" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record).map((record) => record.listingId), ["listing-a", "listing-b"]);
});

test("different confirmed post ids stay separate even when a legacy external id is reused", () => {
  const records = [
    { ...facebook("listing-a", "https://www.facebook.com/groups/a/posts/100000000000001", "legacy-shared", "2026-09-27T12:00:00Z"), contentFingerprint: "same-full-content" },
    { ...facebook("listing-b", "https://www.facebook.com/groups/b/posts/100000000000002", "legacy-shared", "2026-09-27T11:00:00Z"), contentFingerprint: "same-full-content" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record).map((record) => record.listingId), ["listing-a", "listing-b"]);
});

test("the same confirmed post id still deduplicates when its content changes", () => {
  const records = [
    { ...facebook("listing-newer", "https://www.facebook.com/groups/a/posts/100000000000001", "100000000000001", "2026-09-27T12:00:00Z"), contentFingerprint: "before" },
    { ...facebook("listing-older", "https://www.facebook.com/groups/b/posts/100000000000001", "100000000000001", "2026-09-27T11:00:00Z"), contentFingerprint: "after" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record).map((record) => record.listingId), ["listing-newer"]);
});

test("parameter fingerprint requires a location and keeps distinct parameters separate", () => {
  assert.equal(canonicalFacebookParameterFingerprint({ title: "Mieszkanie", price: 280000, area: 59.9, rooms: 2 }), null);
  const first = canonicalFacebookParameterFingerprint({ title: "Mieszkanie", price: 280000, area: 59.9, rooms: 2, location: "Bałuty, Łódź" });
  const second = canonicalFacebookParameterFingerprint({ title: "Mieszkanie", price: 550000, area: 55, rooms: 2, location: "Bałuty, Łódź" });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first, second);
});

test("same non-Facebook source URL is deduplicated even when external ids differ", () => {
  const records = [
    { listingId: "olx-new", source: "olx", externalListingId: "new-id", originalUrl: "https://www.olx.pl/d/oferta/mieszkanie-lodz-IDnew/?utm_source=feed&fbclid=tracking" },
    { listingId: "olx-old", source: "olx", externalListingId: "old-id", originalUrl: "https://olx.pl/d/oferta/mieszkanie-lodz-IDnew" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record), [records[0]]);
});

test("Otodom .html and extensionless offer URLs deduplicate even when external ids differ", () => {
  const records = [
    { listingId: "otodom-new", source: "otodom", externalListingId: "new-id", originalUrl: "https://www.otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS.html?utm_source=feed" },
    { listingId: "otodom-old", source: "otodom", externalListingId: "old-id", originalUrl: "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record), [records[0]]);
});

test("different confirmed Otodom offer ids remain separate", () => {
  const records = [
    { listingId: "otodom-a", source: "otodom", externalListingId: "id-a", originalUrl: "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CRDS.html" },
    { listingId: "otodom-b", source: "otodom", externalListingId: "id-b", originalUrl: "https://otodom.pl/pl/oferta/mieszkanie-lodz-ID4CKQu" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record).map((record) => record.listingId), ["otodom-a", "otodom-b"]);
});

test("same normalized URL deduplication never crosses source boundaries", () => {
  const records = [
    { listingId: "olx-1", source: "olx", externalListingId: "shared", originalUrl: "https://example.test/listing/1?utm_campaign=x" },
    { listingId: "morizon-1", source: "morizon", externalListingId: "shared", originalUrl: "https://example.test/listing/1" },
  ];
  assert.deepEqual(dedupeByListingIdentity(records, (record) => record), records);
});
