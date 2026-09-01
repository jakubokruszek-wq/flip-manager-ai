(function installCollectorRuntime(root) {
  "use strict";

  if (root.FlipCollectorRuntime) return;

  function timeoutError(code, diagnostics = {}) {
    const error = new Error(code);
    error.code = code;
    error.diagnostics = safeDiagnostics(diagnostics);
    return error;
  }

  function withTimeout(value, timeoutMs, code, diagnostics = {}) {
    const startedAt = Date.now();
    const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(code, { ...diagnostics, elapsedMs: Date.now() - startedAt })), boundedTimeoutMs);
    });
    return Promise.race([Promise.resolve(value), timeout]).finally(() => { if (timer !== null) clearTimeout(timer); });
  }

  function createDeadline(timeoutMs, code = "SOURCE_COLLECTION_DEADLINE_EXCEEDED") {
    const startedAt = Date.now();
    const expiresAt = startedAt + Math.max(1, Math.floor(timeoutMs));
    let exceeded = false;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        exceeded = true;
        reject(timeoutError(code, { elapsedMs: Date.now() - startedAt }));
      }, Math.max(1, expiresAt - Date.now()));
    });
    return {
      startedAt,
      expiresAt,
      timeout,
      isExceeded: () => exceeded || Date.now() >= expiresAt,
      remainingMs: () => Math.max(0, expiresAt - Date.now()),
      assertActive(diagnostics = {}) {
        if (exceeded || Date.now() >= expiresAt) {
          exceeded = true;
          throw timeoutError(code, { ...diagnostics, elapsedMs: Date.now() - startedAt });
        }
      },
      cancel() { if (timer !== null) clearTimeout(timer); timer = null; },
    };
  }

  async function sendMessageWithTimeout(sendMessage, options) {
    const startedAt = Date.now();
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
    try {
      const response = await withTimeout(
        Promise.resolve().then(sendMessage),
        timeoutMs,
        options.timeoutCode || "COLLECT_SOURCE_RESPONSE_TIMEOUT",
        options.diagnostics,
      );
      return { response, elapsedMs: Date.now() - startedAt };
    } catch (error) {
      if (error && typeof error === "object") {
        error.diagnostics = safeDiagnostics({ ...(error.diagnostics || {}), ...(options.diagnostics || {}), elapsedMs: Date.now() - startedAt });
      }
      throw error;
    }
  }

  function safeDiagnostics(value) {
    const output = {};
    if (typeof value.query === "string") output.query = value.query.slice(0, 120);
    if (Number.isInteger(value.tabId) && value.tabId >= 0) output.tabId = value.tabId;
    if (Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) output.elapsedMs = Math.floor(value.elapsedMs);
    if (typeof value.source === "string") output.source = value.source.slice(0, 160);
    if (typeof value.stage === "string") output.stage = value.stage.slice(0, 80);
    return output;
  }

  root.FlipCollectorRuntime = { createDeadline, safeDiagnostics, sendMessageWithTimeout, timeoutError, withTimeout };
})(globalThis);
