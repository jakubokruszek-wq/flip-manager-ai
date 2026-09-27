import assert from "node:assert/strict";
import test from "node:test";
import { dedupeByListingIdentity } from "./listing-identity.ts";

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
