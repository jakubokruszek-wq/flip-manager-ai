(() => {
"use strict";

const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);

if (!globalThis.__flipCollectorBootstrapInstalled) {
  globalThis.__flipCollectorBootstrapInstalled = true;
  globalThis.FLIP_COLLECTOR_BOOTSTRAP_LOADED = true;
  markBootstrapLoaded();
  console.debug("FLIP_COLLECTOR_BOOTSTRAP_LOADED");
  void sendRuntime({ type: "BOOTSTRAP_LOADED", origin: location.origin });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || !ALLOWED_ORIGINS.has(event.origin)) return;
    const requestId = safeRequestId(event.data?.requestId);
    if (requestId === "unknown") return;

    if (event.data?.type === "FLIP_COLLECTOR_BOOTSTRAP_PING") {
      void trace(requestId, "BOOTSTRAP_RECEIVED_PING").then(() => sendRuntime({ type: "BOOTSTRAP_RUNTIME_PING", requestId })).then((result) => {
        return trace(requestId, "BOOTSTRAP_SENT_PONG", result?.ok === true ? "PASS" : "FAIL", result?.error).then(() => respond(event.origin, "FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, result));
      }).catch((error) => respond(event.origin, "FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, { ok: false, error: safeError(error) }));
      return;
    }

    if (event.data?.type === "FLIP_COLLECTOR_BRIDGE_PING") {
      respond(event.origin, "FLIP_COLLECTOR_BRIDGE_PONG", requestId, { ok: true });
      return;
    }

    if (event.data?.type === "FLIP_COLLECTOR_READY_REQUEST") {
      void sendRuntime({ type: "CHECK_COLLECTOR_READY", requestId }).then((result) => respond(event.origin, "FLIP_COLLECTOR_READY_RESULT", requestId, result)).catch((error) => respond(event.origin, "FLIP_COLLECTOR_READY_RESULT", requestId, { ok: false, status: "UNVERIFIED", error: safeError(error) }));
      return;
    }

    if (event.data?.type === "FLIP_COLLECTOR_SCAN_REQUEST") {
      const scanId = typeof event.data.scanId === "string" ? event.data.scanId : "";
      void sendRuntime({ type: "COLLECT_PRODUCTION_SOURCE", scanId, requestId }).then((result) => respond(event.origin, "FLIP_COLLECTOR_SCAN_RESULT", requestId, { ...result, scanId })).catch((error) => respond(event.origin, "FLIP_COLLECTOR_SCAN_RESULT", requestId, { ok: false, scanId, error: safeError(error) }));
    }
  });
}

function markBootstrapLoaded() {
  const mark = () => { if (document.documentElement) document.documentElement.dataset.flipCollectorBootstrap = "1"; };
  mark();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", mark, { once: true });
}

function respond(origin, type, requestId, value) { window.postMessage({ type, requestId, ...publicResult(value) }, origin); }
function publicResult(value) { return { ok: value?.ok === true, accepted: value?.accepted === true, status: value?.status, label: value?.label, lastHeartbeatAt: value?.lastHeartbeatAt, health: value?.health, error: value?.error, scanId: value?.scanId }; }
function sendRuntime(message) { return new Promise((resolve, reject) => { chrome.runtime.sendMessage(message, (result) => { const runtimeError = chrome.runtime.lastError; if (runtimeError) reject(new Error(runtimeError.message)); else resolve(result || { ok: false, error: "EXTENSION_NO_RESPONSE" }); }); }); }
function trace(requestId, stage, status = "PASS", errorCode) { return sendRuntime({ type: "RECORD_START_TRACE", requestId, stage, status, errorCode }); }
function safeRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "unknown"; }
function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
})();
