(function installCollectorStartPreflight(root) {
  "use strict";

  if (root.FlipCollectorStartPreflight) return;

  const HEALTH_REFRESH_TIMEOUT_MS = 6_000;

  async function refreshCollectorHealth(options) {
    const requestId = options.requestId;
    const value = await options.readPairing();
    const local = options.localPairingStatus(value);
    if (local.status === "DISCONNECTED" || local.status === "RECONNECT_REQUIRED") {
      const error = local.status === "DISCONNECTED" ? "PAIRING_MISSING" : "PAIRING_RECONNECT_REQUIRED";
      await safeTrace(options, requestId, "HEARTBEAT_UPDATED", "FAIL", error);
      return { ok: false, heartbeatUpdated: false, status: local.status, label: local.label, error };
    }

    try {
      await options.heartbeat(HEALTH_REFRESH_TIMEOUT_MS);
      const verified = await options.persistVerification(value, { kind: "VALID" });
      await safeTrace(options, requestId, "HEARTBEAT_UPDATED", "PASS");
      return {
        ok: true,
        heartbeatUpdated: true,
        status: verified.status,
        label: verified.label,
        lastHeartbeatAt: verified.lastHeartbeatAt,
        health: verified.health,
      };
    } catch (error) {
      const verified = await options.persistVerification(value, options.verificationOutcome(error));
      const code = verified.status === "RECONNECT_REQUIRED" ? "PAIRING_RECONNECT_REQUIRED" : "COLLECTOR_HEALTH_REFRESH_FAILED";
      await safeTrace(options, requestId, "HEARTBEAT_UPDATED", "FAIL", code);
      return { ok: false, heartbeatUpdated: false, status: verified.status, label: verified.label, error: code };
    }
  }

  async function safeTrace(options, requestId, stage, status, errorCode) {
    try { await options.trace(requestId, stage, status, errorCode); } catch { /* diagnostics never block preflight */ }
  }

  root.FlipCollectorStartPreflight = { HEALTH_REFRESH_TIMEOUT_MS, refreshCollectorHealth };
})(globalThis);
