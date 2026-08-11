import assert from "node:assert/strict";
import test from "node:test";

import { latestScanCounters } from "./dashboard.ts";

test("maps persisted scan update and price-drop counters to the UI", () => {
  assert.deepEqual(
    latestScanCounters({ listingsUpdated: 1, priceDropCount: 1 }),
    { updatedCount: 1, priceDropCount: 1 },
  );
});
