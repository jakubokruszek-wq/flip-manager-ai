import assert from "node:assert/strict";
import test from "node:test";

import { collectorDeviceActivityPatch } from "./device-heartbeat.ts";

test("explicit collector heartbeat refresh marks the device healthy atomically", () => {
  const now = "2026-09-01T20:00:00.000Z";
  assert.deepEqual(collectorDeviceActivityPatch(now, true), {
    last_used_at: now,
    last_heartbeat_at: now,
    health_status: "HEALTHY",
  });
});

test("other signed collector requests preserve the existing health status", () => {
  const now = "2026-09-01T20:00:00.000Z";
  assert.deepEqual(collectorDeviceActivityPatch(now, false), {
    last_used_at: now,
    last_heartbeat_at: now,
  });
});
