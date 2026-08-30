(() => {
"use strict";

const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);
const BOOTSTRAP_STATE_KEY = "__flipCollectorBootstrapState";

void initializeBootstrap().catch((error) => invalidateBootstrap(globalThis[BOOTSTRAP_STATE_KEY], error));

async function initializeBootstrap() {
  const health = await sendRuntime({ type: "BOOTSTRAP_CONTEXT_HEALTH", origin: location.origin });
  if (health?.ok !== true || typeof health.runtimeGeneration !== "string") throw new Error(health?.error || "EXTENSION_RUNTIME_UNHEALTHY");
  const existing = globalThis[BOOTSTRAP_STATE_KEY];
  if (existing?.status === "HEALTHY" && existing.runtimeGeneration === health.runtimeGeneration) return;
  if (typeof existing?.listener === "function") window.removeEventListener("message", existing.listener);
  const state = { status: "INSTALLING", runtimeGeneration: health.runtimeGeneration, listener: null };
  globalThis[BOOTSTRAP_STATE_KEY] = state;
  state.listener = createMessageListener(state);
  window.addEventListener("message", state.listener);
  state.status = "HEALTHY";
  globalThis.FLIP_COLLECTOR_BOOTSTRAP_LOADED = true;
  markBootstrapLoaded("1");
  console.debug("FLIP_COLLECTOR_BOOTSTRAP_LOADED");
  await sendRuntime({ type: "BOOTSTRAP_LOADED", origin: location.origin, runtimeGeneration: health.runtimeGeneration });
}

function createMessageListener(state) {
  return (event) => {
    if (state.status !== "HEALTHY") return;
    if (event.source !== window || event.origin !== location.origin || !ALLOWED_ORIGINS.has(event.origin)) return;
    const requestId = safeRequestId(event.data?.requestId);
    if (requestId === "unknown") return;

    if (event.data?.type === "FLIP_COLLECTOR_BOOTSTRAP_PING") {
      void trace(requestId, "BOOTSTRAP_RECEIVED_PING").then(() => sendRuntime({ type: "BOOTSTRAP_RUNTIME_PING", requestId })).then((result) => {
        return trace(requestId, "BOOTSTRAP_SENT_PONG", result?.ok === true ? "PASS" : "FAIL", result?.error).then(() => respond(event.origin, "FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, result));
      }).catch((error) => { if (!handleRuntimeFailure(state, error)) respond(event.origin, "FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, { ok: false, error: safeError(error) }); });
      return;
    }

    if (event.data?.type === "FLIP_COLLECTOR_BRIDGE_PING") {
      respond(event.origin, "FLIP_COLLECTOR_BRIDGE_PONG", requestId, { ok: true });
      return;
    }

    if (event.data?.type === "FLIP_COLLECTOR_READY_REQUEST") {
      void sendRuntime({ type: "CHECK_COLLECTOR_READY", requestId }).then((result) => respond(event.origin, "FLIP_COLLECTOR_READY_RESULT", requestId, result)).catch((error) => { if (!handleRuntimeFailure(state, error)) respond(event.origin, "FLIP_COLLECTOR_READY_RESULT", requestId, { ok: false, status: "UNVERIFIED", error: safeError(error) }); });
      return;
    }

    if (event.data?.type === "FLIP_COLLECTOR_SCAN_REQUEST") {
      const scanId = typeof event.data.scanId === "string" ? event.data.scanId : "";
      void sendRuntime({ type: "COLLECT_PRODUCTION_SOURCE", scanId, requestId }).then((result) => respond(event.origin, "FLIP_COLLECTOR_SCAN_RESULT", requestId, { ...result, scanId })).catch((error) => { if (!handleRuntimeFailure(state, error)) respond(event.origin, "FLIP_COLLECTOR_SCAN_RESULT", requestId, { ok: false, scanId, error: safeError(error) }); });
    }
  };
}

function markBootstrapLoaded(value) {
  const mark = () => { if (document.documentElement) document.documentElement.dataset.flipCollectorBootstrap = value; };
  mark();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", mark, { once: true });
}

function respond(origin, type, requestId, value) { window.postMessage({ type, requestId, ...publicResult(value) }, origin); }
function publicResult(value) { return { ok: value?.ok === true, accepted: value?.accepted === true, status: value?.status, label: value?.label, lastHeartbeatAt: value?.lastHeartbeatAt, health: value?.health, error: value?.error, scanId: value?.scanId }; }
function sendRuntime(message) { return new Promise((resolve, reject) => { try { chrome.runtime.sendMessage(message, (result) => { try { const runtimeError = chrome.runtime.lastError; if (runtimeError) reject(normalizeRuntimeError(runtimeError)); else resolve(result || { ok: false, error: "EXTENSION_NO_RESPONSE" }); } catch (error) { reject(normalizeRuntimeError(error)); } }); } catch (error) { reject(normalizeRuntimeError(error)); } }); }
function trace(requestId, stage, status = "PASS", errorCode) { return sendRuntime({ type: "RECORD_START_TRACE", requestId, stage, status, errorCode }); }
function safeRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "unknown"; }
function normalizeRuntimeError(error) { const message = error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(error || ""); return new Error(/extension context invalidated/i.test(message) ? "EXTENSION_CONTEXT_INVALIDATED" : message.slice(0, 300) || "EXTENSION_RUNTIME_FAILED"); }
function handleRuntimeFailure(state, error) { if (safeError(error) !== "EXTENSION_CONTEXT_INVALIDATED") return false; invalidateBootstrap(state, error); return true; }
function invalidateBootstrap(state, error) { if (!state || globalThis[BOOTSTRAP_STATE_KEY] !== state) return; state.status = "STALE"; if (typeof state.listener === "function") window.removeEventListener("message", state.listener); globalThis.FLIP_COLLECTOR_BOOTSTRAP_LOADED = false; markBootstrapLoaded("stale"); console.debug("FLIP_COLLECTOR_BOOTSTRAP_STALE", safeError(error)); }
function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
})();
