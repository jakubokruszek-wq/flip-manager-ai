import test from "node:test";
import assert from "node:assert/strict";
import { planFacebookWatcherHistoryClear } from "./history-clear.ts";

test("Watcher clear removes pure Facebook listings but preserves cross-source and CRM records", () => {
  assert.deepEqual(planFacebookWatcherHistoryClear([
    { listingId: "pure" }, { listingId: "cross", crossSourceMatch: true }, { listingId: "crm", linkedProperty: true }, { listingId: "deal", linkedDeal: true },
  ]), { pureFacebookListingIds: ["pure"], preservedListingIds: ["cross", "crm", "deal"], removedAssociationListingIds: ["cross", "crm", "deal"] });
});
