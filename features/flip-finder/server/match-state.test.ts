import assert from "node:assert/strict";
import test from "node:test";
import { staleListingFilterMatchKey, staleListingFilterMatchValues } from "./match-state.ts";

test("stale match deactivation targets only the composite listing/filter key", () => {
  assert.deepEqual(staleListingFilterMatchKey("listing-1", "filter-1"), { listingId: "listing-1", searchFilterId: "filter-1" });
  assert.deepEqual(staleListingFilterMatchValues(), { is_current_match: false });
});
