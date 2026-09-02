(() => {
"use strict";

const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);
const BOOTSTRAP_STATE_KEY = "__flipCollectorBootstrapState";

const bootstrapState = ensureMessageListener();
void initializeBootstrap(bootstrapState).catch((error) => invalidateBootstrap(bootstrapState, error));

function ensureMessageListener() {
  const existing = globalThis[BOOTSTRAP_STATE_KEY];
  if (existing?.status !== "STALE" && typeof existing?.listener === "function") return existing;
  if (typeof existing?.listener === "function") document.removeEventListener("flip-collector-bootstrap-ping", existing.listener);
  const state = { status: "INSTALLING", runtimeGeneration: null, listener: null };
  globalThis[BOOTSTRAP_STATE_KEY] = state;
  state.listener = createMessageListener(state);
  document.addEventListener("flip-collector-bootstrap-ping", state.listener);
  markListenerRegistered();
  recordBootstrapBeacon("LISTENER_REGISTERED");
  console.debug("FLIP_COLLECTOR_BOOTSTRAP_LISTENER_REGISTERED");
  return state;
}

async function initializeBootstrap(state) {
  const health = await sendRuntime({ type: "BOOTSTRAP_CONTEXT_HEALTH", origin: location.origin });
  if (health?.ok !== true || typeof health.runtimeGeneration !== "string") throw new Error(health?.error || "EXTENSION_RUNTIME_UNHEALTHY");
  if (globalThis[BOOTSTRAP_STATE_KEY] !== state || state.status === "STALE") return;
  state.runtimeGeneration = health.runtimeGeneration;
  state.status = "HEALTHY";
  globalThis.FLIP_COLLECTOR_BOOTSTRAP_LOADED = true;
  markBootstrapLoaded(health.runtimeGeneration, state);
  console.debug("FLIP_COLLECTOR_BOOTSTRAP_LOADED");
  await sendRuntime({ type: "BOOTSTRAP_LOADED", origin: location.origin, runtimeGeneration: health.runtimeGeneration });
}

function createMessageListener(state) {
  return (event) => {
    if (state.status === "STALE") return;
    if (event.target !== document || !event.detail || !ALLOWED_ORIGINS.has(location.origin)) return;
    const message = event.detail;
    const requestId = safeRequestId(message?.requestId);
    if (requestId === "unknown") return;
    const eventType = typeof message?.type === "string" ? message.type.slice(0, 80) : "UNKNOWN";

    if (message?.type === "FLIP_COLLECTOR_BOOTSTRAP_PING") {
      recordBootstrapBeacon("BOOTSTRAP_EVENT_RECEIVED", requestId, eventType);
      respond("FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, { ok: true, status: state.status });
      recordBootstrapBeacon("BOOTSTRAP_PONG_DISPATCHED", requestId, eventType);
      void trace(requestId, "BOOTSTRAP_RECEIVED_PING").then(() => trace(requestId, "BOOTSTRAP_SENT_PONG")).then(() => sendRuntime({ type: "BOOTSTRAP_RUNTIME_PING", requestId })).catch((error) => { handleRuntimeFailure(state, error); });
      return;
    }

    if (message?.type === "FLIP_COLLECTOR_BRIDGE_PING") {
      recordBootstrapBeacon("BOOTSTRAP_EVENT_RECEIVED", requestId, eventType);
      respond("FLIP_COLLECTOR_BRIDGE_PONG", requestId, { ok: true });
      return;
    }

    if (message?.type === "FLIP_COLLECTOR_READY_REQUEST") {
      recordBootstrapBeacon("BOOTSTRAP_EVENT_RECEIVED", requestId, eventType);
      void sendRuntime({ type: "CHECK_COLLECTOR_READY", requestId }).then((result) => respond("FLIP_COLLECTOR_READY_RESULT", requestId, result)).catch((error) => { if (!handleRuntimeFailure(state, error)) respond("FLIP_COLLECTOR_READY_RESULT", requestId, { ok: false, status: "UNVERIFIED", error: safeError(error) }); });
      return;
    }

    if (message?.type === "FLIP_COLLECTOR_HEALTH_REFRESH_REQUEST") {
      recordBootstrapBeacon("BOOTSTRAP_EVENT_RECEIVED", requestId, eventType);
      void sendRuntime({ type: "REFRESH_COLLECTOR_HEALTH", requestId }).then((result) => respond("FLIP_COLLECTOR_HEALTH_REFRESH_RESULT", requestId, result)).catch((error) => { if (!handleRuntimeFailure(state, error)) respond("FLIP_COLLECTOR_HEALTH_REFRESH_RESULT", requestId, { ok: false, heartbeatUpdated: false, error: "COLLECTOR_HEALTH_REFRESH_FAILED" }); });
      return;
    }

    if (message?.type === "FLIP_COLLECTOR_VALIDATE_REQUEST") {
      recordBootstrapBeacon("BOOTSTRAP_EVENT_RECEIVED", requestId, eventType);
      void sendRuntime({ type: "VALIDATE_COLLECTOR", requestId }).then((result) => respond("FLIP_COLLECTOR_VALIDATE_RESULT", requestId, result)).catch((error) => { if (!handleRuntimeFailure(state, error)) respond("FLIP_COLLECTOR_VALIDATE_RESULT", requestId, { ok: false, error: "COLLECTOR_VALIDATION_FAILED" }); });
      return;
    }

    if (message?.type === "FLIP_COLLECTOR_SCAN_REQUEST") {
      recordBootstrapBeacon("BOOTSTRAP_EVENT_RECEIVED", requestId, eventType);
      const scanId = typeof message.scanId === "string" ? message.scanId : "";
      void sendRuntime({ type: "COLLECT_PRODUCTION_SOURCE", scanId, requestId }).then((result) => respond("FLIP_COLLECTOR_SCAN_RESULT", requestId, { ...result, scanId })).catch((error) => { if (!handleRuntimeFailure(state, error)) respond("FLIP_COLLECTOR_SCAN_RESULT", requestId, { ok: false, scanId, error: safeError(error) }); });
    }
  };
}

function markListenerRegistered() {
  const mark = () => { if (!document.documentElement) return false; document.documentElement.setAttribute("data-flip-collector-bootstrap-listener", "registered"); return true; };
  mark();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", mark, { once: true });
  if (!document.documentElement && typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => { if (mark()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 1_000);
  }
}

function recordBootstrapBeacon(stage, requestId, eventType) {
  const beacon = { stage, timestamp: new Date().toISOString(), ...(requestId ? { requestId } : {}), ...(eventType ? { eventType } : {}) };
  const storageKey = stage === "LISTENER_REGISTERED" ? "collectorBootstrapListenerBeacon" : stage === "PAGE_MESSAGE_RECEIVED" ? "collectorBootstrapPageMessageBeacon" : "collectorBootstrapPongBeacon";
  try {
    const write = chrome.storage?.local?.set?.({ [storageKey]: beacon });
    if (write && typeof write.catch === "function") void write.catch(() => {});
  } catch {}
}

function markBootstrapLoaded(value, state) {
  const mark = () => { if (state?.status !== "HEALTHY" || !document.documentElement) return false; document.documentElement.setAttribute("data-flip-collector-bootstrap", value); return true; };
  mark();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", mark, { once: true });
  if (!document.documentElement && typeof MutationObserver === "function") {
    const observer = new MutationObserver(() => { if (mark()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 1_000);
  }
  for (const delay of [0, 50, 250]) setTimeout(mark, delay);
}

function respond(type, requestId, value) { document.dispatchEvent(new CustomEvent(domEventName(type), { detail: { type, requestId, ...publicResult(value) } })); }
function domEventName(type) { return `flip-collector-${String(type).replace(/^FLIP_COLLECTOR_/, "").toLowerCase().replaceAll("_", "-")}`; }
function publicResult(value) { return { ok: value?.ok === true, accepted: value?.accepted === true, heartbeatUpdated: value?.heartbeatUpdated === true, validation: value?.validation, status: value?.status, label: value?.label, lastHeartbeatAt: value?.lastHeartbeatAt, health: value?.health, error: value?.error, scanId: value?.scanId }; }
function sendRuntime(message) { return new Promise((resolve, reject) => { try { chrome.runtime.sendMessage(message, (result) => { try { const runtimeError = chrome.runtime.lastError; if (runtimeError) reject(normalizeRuntimeError(runtimeError)); else resolve(result || { ok: false, error: "EXTENSION_NO_RESPONSE" }); } catch (error) { reject(normalizeRuntimeError(error)); } }); } catch (error) { reject(normalizeRuntimeError(error)); } }); }
function trace(requestId, stage, status = "PASS", errorCode) { return sendRuntime({ type: "RECORD_START_TRACE", requestId, stage, status, errorCode }); }
function safeRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "unknown"; }
function normalizeRuntimeError(error) { const message = error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(error || ""); return new Error(/extension context invalidated/i.test(message) ? "EXTENSION_CONTEXT_INVALIDATED" : message.slice(0, 300) || "EXTENSION_RUNTIME_FAILED"); }
function handleRuntimeFailure(state, error) { if (safeError(error) !== "EXTENSION_CONTEXT_INVALIDATED") return false; invalidateBootstrap(state, error); return true; }
function invalidateBootstrap(state, error) { if (!state || globalThis[BOOTSTRAP_STATE_KEY] !== state) return; state.status = "STALE"; if (typeof state.listener === "function") document.removeEventListener("flip-collector-bootstrap-ping", state.listener); globalThis.FLIP_COLLECTOR_BOOTSTRAP_LOADED = false; if (document.documentElement) document.documentElement.setAttribute("data-flip-collector-bootstrap", "stale"); console.debug("FLIP_COLLECTOR_BOOTSTRAP_STALE", safeError(error)); }
function safeError(error) { return error instanceof Error ? error.message.slice(0, 300) : "COLLECTOR_FAILED"; }
})();
