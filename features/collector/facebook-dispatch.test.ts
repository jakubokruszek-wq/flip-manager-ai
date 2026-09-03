import assert from "node:assert/strict";
import test from "node:test";

import { FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS, FACEBOOK_PRODUCTION_SOURCE_ID, FACEBOOK_PRODUCTION_SOURCE_URL, FACEBOOK_PRODUCTION_SOURCES, isCollectorHeartbeatFresh, isFacebookProductionSource } from "./facebook-production.ts";

test("production dispatch accepts all explicitly allowlisted Facebook sources", () => {
  assert.equal(isFacebookProductionSource({ sourceId: FACEBOOK_PRODUCTION_SOURCE_ID, type: "GROUP", url: FACEBOOK_PRODUCTION_SOURCE_URL }), true);
  for (const source of FACEBOOK_PRODUCTION_SOURCES) {
    assert.equal(isFacebookProductionSource({ sourceId: source.sourceId, type: source.sourceType, url: source.sourceUrl }), true, source.sourceId);
  }
  assert.equal(isFacebookProductionSource({ sourceId: "not-allowlisted", type: "GROUP", url: "https://www.facebook.com/groups/not-allowlisted/" }), false);
  assert.equal(isFacebookProductionSource({ sourceId: "61563667387467", type: "GROUP", url: "https://www.facebook.com/profile.php?id=61563667387467" }), false);
});

test("stale or failed collector heartbeat is not ready", () => {
  const now = Date.parse("2026-08-30T12:00:00Z");
  assert.equal(isCollectorHeartbeatFresh("2026-08-30T11:59:00Z", now, "HEALTHY"), true);
  assert.equal(isCollectorHeartbeatFresh(new Date(now - FACEBOOK_COLLECTOR_HEARTBEAT_MAX_AGE_MS - 1).toISOString(), now, "HEALTHY"), false);
  assert.equal(isCollectorHeartbeatFresh("2026-08-30T11:59:00Z", now, "FAILED"), false);
});
