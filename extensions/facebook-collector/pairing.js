"use strict";

const FLIP_ORIGIN = "https://flip-manager-ai.vercel.app";

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== FLIP_ORIGIN) return;
  if (event.data?.type === "FLIP_COLLECTOR_STATUS_REQUEST") {
    await publishPairingStatus(event.origin);
    return;
  }
  if (event.data?.type !== "FLIP_COLLECTOR_PAIRING_REQUEST") return;
  const { challenge, deviceName, installationId } = event.data;
  try {
    const response = await fetch(`${FLIP_ORIGIN}/api/collector/pairing/complete`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge, deviceName, installationId }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.deviceId !== "string" || typeof data.deviceToken !== "string") throw new Error(data.message || "PAIRING_FAILED");
    await chrome.runtime.sendMessage({ type: "SAVE_PAIRING_CONFIG", config: { apiUrl: FLIP_ORIGIN, deviceId: data.deviceId, deviceToken: data.deviceToken } });
    window.postMessage({ type: "FLIP_COLLECTOR_PAIRING_RESULT", ok: true }, event.origin);
    await publishPairingStatus(event.origin);
  } catch (error) {
    window.postMessage({ type: "FLIP_COLLECTOR_PAIRING_RESULT", ok: false, message: error instanceof Error ? error.message : "PAIRING_FAILED" }, event.origin);
  }
});

async function publishPairingStatus(origin) {
  try {
    const local = await chrome.runtime.sendMessage({ type: "GET_PAIRING_STATUS" });
    postPublicStatus(local, origin);
    if (local?.shouldVerify) postPublicStatus(await chrome.runtime.sendMessage({ type: "VERIFY_PAIRING_STATUS" }), origin);
  } catch {
    postPublicStatus({ status: "UNVERIFIED", label: "Połączenie niezweryfikowane", shouldVerify: true }, origin);
  }
}

function postPublicStatus(value, origin) {
  window.postMessage({
    type: "FLIP_COLLECTOR_STATUS_RESULT",
    status: value?.status,
    label: value?.label,
    deviceLabel: value?.deviceLabel,
    lastHeartbeatAt: value?.lastHeartbeatAt,
    lastSuccessfulScanAt: value?.lastSuccessfulScanAt,
    health: value?.health,
  }, origin);
}
