"use strict";

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== "https://flip-manager-ai.vercel.app" || event.data?.type !== "FLIP_COLLECTOR_PAIRING_REQUEST") return;
  const { challenge, deviceName, installationId } = event.data;
  try {
    const response = await fetch("https://flip-manager-ai.vercel.app/api/collector/pairing/complete", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge, deviceName, installationId }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || typeof data.deviceId !== "string" || typeof data.deviceToken !== "string") throw new Error(data.message || "PAIRING_FAILED");
    await chrome.runtime.sendMessage({ type: "SAVE_PAIRING_CONFIG", config: { apiUrl: "https://flip-manager-ai.vercel.app", deviceId: data.deviceId, deviceToken: data.deviceToken } });
    window.postMessage({ type: "FLIP_COLLECTOR_PAIRING_RESULT", ok: true }, event.origin);
  } catch (error) { window.postMessage({ type: "FLIP_COLLECTOR_PAIRING_RESULT", ok: false, message: error instanceof Error ? error.message : "PAIRING_FAILED" }, event.origin); }
});
