(function installPairingStatus(scope) {
  "use strict";

  const STATUS = Object.freeze({
    CONNECTED: "CONNECTED",
    DISCONNECTED: "DISCONNECTED",
    RECONNECT_REQUIRED: "RECONNECT_REQUIRED",
    UNVERIFIED: "UNVERIFIED",
  });
  const VERIFIED_TTL_MS = 5 * 60 * 1000;

  function localPairingStatus(storage, now = Date.now()) {
    const credentials = hasCredentials(storage);
    if (!credentials) return publicStatus(STATUS.DISCONNECTED, storage, { shouldVerify: false });
    const saved = record(storage?.collectorPairingState);
    const sameDevice = !saved?.deviceId || saved.deviceId === storage.deviceId;
    const sameEndpoint = saved?.apiUrl === storage.apiUrl;
    if (sameDevice && sameEndpoint && saved?.status === STATUS.RECONNECT_REQUIRED) {
      return publicStatus(STATUS.RECONNECT_REQUIRED, storage, { shouldVerify: false, reason: saved.reason });
    }
    const verifiedAt = timestamp(saved?.verifiedAt);
    if (sameDevice && sameEndpoint && saved?.status === STATUS.CONNECTED) {
      return publicStatus(STATUS.CONNECTED, storage, {
        verifiedAt: saved.verifiedAt,
        lastHeartbeatAt: saved.lastHeartbeatAt,
        shouldVerify: !verifiedAt || now - verifiedAt > VERIFIED_TTL_MS,
      });
    }
    return publicStatus(STATUS.UNVERIFIED, storage, { shouldVerify: true, reason: saved?.reason });
  }

  function verifiedPairingStatus(storage, outcome, now = Date.now()) {
    if (!hasCredentials(storage)) {
      const value = publicStatus(STATUS.DISCONNECTED, storage, { shouldVerify: false });
      return { ...value, clearCredentials: false, storageState: null };
    }
    if (outcome?.kind === "VALID") {
      const at = new Date(now).toISOString();
      const value = publicStatus(STATUS.CONNECTED, storage, { verifiedAt: at, lastHeartbeatAt: at, shouldVerify: false });
      return { ...value, clearCredentials: false, storageState: { status: STATUS.CONNECTED, apiUrl: storage.apiUrl, deviceId: storage.deviceId, verifiedAt: at, lastHeartbeatAt: at } };
    }
    if (outcome?.kind === "REVOKED") {
      const value = publicStatus(STATUS.RECONNECT_REQUIRED, storage, { shouldVerify: false, reason: cleanReason(outcome.reason) || "INVALID_DEVICE" });
      return { ...value, clearCredentials: false, storageState: { status: STATUS.RECONNECT_REQUIRED, apiUrl: storage.apiUrl, deviceId: storage.deviceId, verifiedAt: null, lastHeartbeatAt: null, reason: value.reason } };
    }
    const value = publicStatus(STATUS.UNVERIFIED, storage, { shouldVerify: true, reason: cleanReason(outcome?.reason) || "BACKEND_TEMPORARILY_UNAVAILABLE" });
    return { ...value, clearCredentials: false, storageState: { status: STATUS.UNVERIFIED, apiUrl: storage.apiUrl, deviceId: storage.deviceId, verifiedAt: null, lastHeartbeatAt: record(storage?.collectorPairingState)?.lastHeartbeatAt || null, reason: value.reason } };
  }

  function publicStatus(status, storage, extra) {
    const lastResult = record(storage?.collectorLastResult);
    const health = record(lastResult?.health)?.status;
    const deviceId = typeof storage?.deviceId === "string" ? storage.deviceId.trim() : "";
    return {
      status,
      label: label(status),
      shouldVerify: extra?.shouldVerify === true,
      deviceLabel: deviceId ? `Device ••••${deviceId.slice(-6)}` : null,
      verifiedAt: iso(extra?.verifiedAt),
      lastHeartbeatAt: iso(extra?.lastHeartbeatAt),
      lastSuccessfulScanAt: lastResult && health !== "FAILED" ? iso(lastResult.finishedAt) : null,
      health: typeof health === "string" ? health.slice(0, 40) : null,
      reason: cleanReason(extra?.reason),
    };
  }

  function label(status) {
    if (status === STATUS.CONNECTED) return "Połączono";
    if (status === STATUS.RECONNECT_REQUIRED) return "Wymaga ponownego połączenia";
    if (status === STATUS.UNVERIFIED) return "Połączenie niezweryfikowane";
    return "Niepołączono";
  }

  function hasCredentials(value) {
    return typeof value?.apiUrl === "string" && /^https?:\/\//.test(value.apiUrl)
      && typeof value?.deviceId === "string" && value.deviceId.trim().length > 0
      && typeof value?.deviceToken === "string" && value.deviceToken.trim().length > 0;
  }
  function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null; }
  function timestamp(value) { const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; }
  function iso(value) { return timestamp(value) ? new Date(value).toISOString() : null; }
  function cleanReason(value) { return typeof value === "string" ? value.replace(/[^A-Z0-9_:-]/gi, "").slice(0, 120) || null : null; }

  scope.FlipCollectorPairingStatus = { STATUS, localPairingStatus, verifiedPairingStatus };
})(typeof globalThis === "object" ? globalThis : self);
