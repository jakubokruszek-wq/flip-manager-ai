"use strict";

const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);

window.addEventListener("message", (event) => {
  if (event.source !== window || !ALLOWED_ORIGINS.has(event.origin)) return;
  if (event.data?.type === "FLIP_COLLECTOR_READY_REQUEST") {
    const requestId = safeRequestId(event.data.requestId);
    void trace(requestId, "BRIDGE_RECEIVED_READY").then(() => chrome.runtime.sendMessage({ type: "CHECK_COLLECTOR_READY", requestId })).then((result) => {
      return trace(requestId, "BRIDGE_RETURNED_READY", result?.ok === true ? "PASS" : "FAIL", result?.error).then(() => window.postMessage({ type: "FLIP_COLLECTOR_READY_RESULT", requestId, ...publicResult(result) }, event.origin));
    }).catch((error) => window.postMessage({ type: "FLIP_COLLECTOR_READY_RESULT", requestId, ok: false, status: "UNVERIFIED", error: safeError(error) }, event.origin));
    return;
  }
  if (event.data?.type !== "FLIP_COLLECTOR_SCAN_REQUEST") return;
  const scanId = typeof event.data.scanId === "string" ? event.data.scanId : "";
  const requestId = safeRequestId(event.data.requestId);
  void trace(requestId, "BRIDGE_RECEIVED_SCAN_COMMAND").then(() => chrome.runtime.sendMessage({ type: "COLLECT_PRODUCTION_SOURCE", scanId, requestId })).then((result) => {
    window.postMessage({ type: "FLIP_COLLECTOR_SCAN_RESULT", requestId, ...publicResult(result), scanId }, event.origin);
  }).catch((error) => window.postMessage({ type: "FLIP_COLLECTOR_SCAN_RESULT", requestId, ok: false, scanId, error: safeError(error) }, event.origin));
});

function publicResult(value) {
  return { ok: value?.ok === true, accepted: value?.accepted === true, status: value?.status, label: value?.label, lastHeartbeatAt: value?.lastHeartbeatAt, health: value?.health, error: value?.error };
}

function safeRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "unknown"; }
function trace(requestId, stage, status = "PASS", errorCode) { return chrome.runtime.sendMessage({ type: "RECORD_START_TRACE", requestId, stage, status, errorCode: typeof errorCode === "string" ? errorCode.slice(0, 120) : undefined }).catch(() => ({})); }

function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
