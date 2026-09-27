import assert from "node:assert/strict";
import test from "node:test";
import { canonicalFacebookContentFingerprint, canonicalFacebookIdentity, dedupeByListingIdentity } from "./listing-identity.ts";

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

test("identical full-content fingerprints collapse cross-post duplicates, while similar offers remain separate", () => {
  const fingerprint = canonicalFacebookContentFingerprint({ title: "Mieszkanie", description: "Pełny opis oferty", price: 280000, area: 59.9, rooms: 2, location: "Łódź", imageUrls: ["https://img.example/one.jpg"] });
  const duplicate = [
    { ...facebook("listing-a", "https://www.facebook.com/groups/a/posts/100000000000001", "100000000000001", "2026-09-27T12:00:00Z"), contentFingerprint: fingerprint },
    { ...facebook("listing-b", "https://www.facebook.com/groups/b/posts/100000000000002", "100000000000002", "2026-09-27T11:00:00Z"), contentFingerprint: fingerprint },
  ];
  assert.equal(dedupeByListingIdentity(duplicate, (record) => record).length, 1);

  const distinct = duplicate.map((record, index) => ({ ...record, contentFingerprint: `${fingerprint}-${index}` }));
  assert.equal(dedupeByListingIdentity(distinct, (record) => record).length, 2);
});
