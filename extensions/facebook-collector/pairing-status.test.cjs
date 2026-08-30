/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
require("./pairing-status.js");

const core = globalThis.FlipCollectorPairingStatus;
const now = Date.parse("2026-08-30T12:00:00.000Z");
const credentials = { apiUrl: "https://flip-manager-ai.vercel.app", deviceId: "device-123456789", deviceToken: "never-render-this-secret" };

test("paired local state renders Połączono immediately without another click", () => {
  const status = core.localPairingStatus({ ...credentials, collectorPairingState: { status: "CONNECTED", apiUrl: credentials.apiUrl, deviceId: credentials.deviceId, verifiedAt: "2026-08-30T11:59:00.000Z", lastHeartbeatAt: "2026-08-30T11:59:00.000Z" } }, now);
  assert.equal(status.status, "CONNECTED");
  assert.equal(status.label, "Połączono");
  assert.equal(status.shouldVerify, false);
});

test("valid backend verification renders Połączono", () => {
  const status = core.verifiedPairingStatus(credentials, { kind: "VALID" }, now);
  assert.equal(status.status, "CONNECTED");
  assert.equal(status.label, "Połączono");
  assert.equal(status.storageState.status, "CONNECTED");
});

test("revoked token requires pairing again", () => {
  const status = core.verifiedPairingStatus(credentials, { kind: "REVOKED", reason: "INVALID_DEVICE" }, now);
  assert.equal(status.status, "RECONNECT_REQUIRED");
  assert.equal(status.label, "Wymaga ponownego połączenia");
  assert.equal(status.clearCredentials, false);
});

test("missing credentials renders Niepołączono", () => {
  const status = core.localPairingStatus({}, now);
  assert.equal(status.status, "DISCONNECTED");
  assert.equal(status.label, "Niepołączono");
  assert.equal(status.shouldVerify, false);
});

test("temporary backend failure keeps pairing and renders unverified without exposing secrets", () => {
  const status = core.verifiedPairingStatus(credentials, { kind: "TEMPORARY_FAILURE", reason: "COLLECTOR_UPLOAD_503:FAILED" }, now);
  assert.equal(status.status, "UNVERIFIED");
  assert.equal(status.label, "Połączenie niezweryfikowane");
  assert.equal(status.clearCredentials, false);
  assert.equal(status.shouldVerify, true);
  assert.doesNotMatch(JSON.stringify(status), /never-render-this-secret/);
});
