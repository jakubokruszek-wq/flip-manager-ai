"use strict";

const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);

window.addEventListener("message", (event) => {
  if (event.source !== window || !ALLOWED_ORIGINS.has(event.origin)) return;
  if (event.data?.type === "FLIP_COLLECTOR_READY_REQUEST") {
    void chrome.runtime.sendMessage({ type: "CHECK_COLLECTOR_READY" }).then((result) => {
      window.postMessage({ type: "FLIP_COLLECTOR_READY_RESULT", ...publicResult(result) }, event.origin);
    }).catch((error) => window.postMessage({ type: "FLIP_COLLECTOR_READY_RESULT", ok: false, status: "UNVERIFIED", error: safeError(error) }, event.origin));
    return;
  }
  if (event.data?.type !== "FLIP_COLLECTOR_SCAN_REQUEST") return;
  const scanId = typeof event.data.scanId === "string" ? event.data.scanId : "";
  void chrome.runtime.sendMessage({ type: "COLLECT_PRODUCTION_SOURCE", scanId }).then((result) => {
    window.postMessage({ type: "FLIP_COLLECTOR_SCAN_RESULT", ...publicResult(result), scanId }, event.origin);
  }).catch((error) => window.postMessage({ type: "FLIP_COLLECTOR_SCAN_RESULT", ok: false, scanId, error: safeError(error) }, event.origin));
});

function publicResult(value) {
  return { ok: value?.ok === true, accepted: value?.accepted === true, status: value?.status, label: value?.label, lastHeartbeatAt: value?.lastHeartbeatAt, health: value?.health, error: value?.error };
}

function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
