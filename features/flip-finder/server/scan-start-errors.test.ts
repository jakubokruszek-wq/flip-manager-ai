import assert from "node:assert/strict";
import test from "node:test";
import { scanStatus } from "./scan-start-errors.ts";

test("collector offline is a controlled service-unavailable response", () => {
  assert.equal(scanStatus(Object.assign(new Error("COLLECTOR_OFFLINE"), { status: 503 })), 503);
});

test("unknown scan start failures never default to gateway 502", () => {
  assert.equal(scanStatus(new Error("unexpected failure")), 500);
});
