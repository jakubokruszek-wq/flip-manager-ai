"use strict";

const ALLOWED_ORIGIN = "https://flip-manager-ai.vercel.app";

if (!globalThis.__flipCollectorBootstrapInstalled) {
  globalThis.__flipCollectorBootstrapInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== ALLOWED_ORIGIN) return;
    if (event.data?.type !== "FLIP_COLLECTOR_BOOTSTRAP_PING") return;
    const requestId = safeRequestId(event.data.requestId);
    if (requestId === "unknown") return;
    chrome.runtime.sendMessage({ type: "RECOVER_COLLECTOR_BRIDGE", requestId }, (result) => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({ type: "FLIP_COLLECTOR_BOOTSTRAP_PONG", requestId, ok: !runtimeError && result?.ok === true, error: runtimeError?.message || result?.error }, ALLOWED_ORIGIN);
    });
  });
}

function safeRequestId(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "unknown"; }
