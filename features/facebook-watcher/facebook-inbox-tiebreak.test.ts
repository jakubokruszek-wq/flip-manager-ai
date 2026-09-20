import test from "node:test";
import assert from "node:assert/strict";
import { sortFacebookInbox } from "./facebook-inbox.ts";
import type { FacebookWatcherListing } from "./types.ts";

const item = (listingId: string) => ({ listingId, title: "x", city: null, district: null, neighborhood: null, street: null, price: 100, pricePerM2: null, pricePerSqm: 1, area: 100, rooms: null, floor: null, totalFloors: null, marketType: null, sellerType: null, condition: null, description: null, originalUrl: null, images: [], confidence: 1, flags: [], status: "active", workflowStatus: "new", readAt: null, importedAt: "2026-08-09T10:00:00Z", publishedAt: "2026-08-09T10:00:00Z", groupName: null, opportunityScore: 90, flipScore: 90, potentialProfit: 1, isNew: false, highPriority: false, crossSourceMatch: false, crossSourceLinks: [], source: "facebook" } satisfies FacebookWatcherListing);

test("equal Watcher scores use date then listing id as deterministic tie breakers", () => {
  assert.deepEqual(sortFacebookInbox([item("z"), item("a"), item("1")], "opportunity").map((value) => value.listingId), ["1", "a", "z"]);
});

test("when the primary sort key ties, the more recently published item wins BEFORE listing id is ever consulted", () => {
  // "a" sorts before "z" lexicographically, but "z" is the newer publication —
  // proving the date tie-break is consulted first requires a case where the
  // two tie-breakers would disagree.
  const older = { ...item("a"), publishedAt: "2026-08-01T10:00:00Z" };
  const newer = { ...item("z"), publishedAt: "2026-08-09T10:00:00Z" };
  assert.deepEqual(sortFacebookInbox([older, newer], "opportunity").map((value) => value.listingId), ["z", "a"], "the newer publication must win the tie even though its listingId sorts later alphabetically");
});

test("only when the primary key AND the publication date both tie does listing id decide the final order", () => {
  const sameDate = "2026-08-09T10:00:00Z";
  const items = [
    { ...item("z"), publishedAt: sameDate },
    { ...item("a"), publishedAt: sameDate },
    { ...item("1"), publishedAt: sameDate },
  ];
  assert.deepEqual(sortFacebookInbox(items, "opportunity").map((value) => value.listingId), ["1", "a", "z"]);
});
