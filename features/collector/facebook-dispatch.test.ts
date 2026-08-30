import assert from "node:assert/strict";
import test from "node:test";

import { FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS, FACEBOOK_PRODUCTION_SOURCE_ID, FACEBOOK_PRODUCTION_SOURCE_URL, isCollectorHeartbeatFresh, isFacebookProductionSource } from "./facebook-production.ts";

test("production dispatch accepts only the one allowlisted Facebook group", () => {
  assert.equal(isFacebookProductionSource({ sourceId: FACEBOOK_PRODUCTION_SOURCE_ID, type: "GROUP", url: FACEBOOK_PRODUCTION_SOURCE_URL }), true);
  assert.equal(isFacebookProductionSource({ sourceId: "402796264871862", type: "GROUP", url: "https://www.facebook.com/groups/402796264871862/" }), false);
});

test("stale or failed collector heartbeat is not ready", () => {
  const now = Date.parse("2026-08-30T12:00:00Z");
  assert.equal(isCollectorHeartbeatFresh("2026-08-30T11:59:00Z", now, "HEALTHY"), true);
  assert.equal(isCollectorHeartbeatFresh(new Date(now - FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS - 1).toISOString(), now, "HEALTHY"), false);
  assert.equal(isCollectorHeartbeatFresh("2026-08-30T11:59:00Z", now, "FAILED"), false);
});
