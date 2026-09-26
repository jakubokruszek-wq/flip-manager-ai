"use strict";

/**
 * Lets the Manager's "Obserwowane grupy" page (features/facebook-groups/
 * components/watched-groups-page.tsx) drive the ENTIRE group-discovery round
 * trip from one click ("Wykryj grupy nieruchomościowe") instead of requiring
 * the user to separately open Facebook and separately click the extension
 * popup's own button. Mirrors pairing.js's proven window.postMessage bridge
 * pattern (not bootstrap.js's CustomEvent protocol, which nothing on this
 * page uses).
 *
 * Protocol, all via window.postMessage on this exact page's own origin:
 *   page -> extension: { type: "FLIP_GROUP_DISCOVERY_REQUEST" }
 *   extension -> page: { type: "FLIP_GROUP_DISCOVERY_ACK" }
 *     (sent immediately, before anything else runs, so the page can tell
 *     "the extension is installed and received the command" apart from
 *     "no extension is listening at all" -- required by the mission this
 *     bridge exists for: never show a generic "no groups" message when the
 *     real problem is the extension not working.)
 *   extension -> page: { type: "FLIP_GROUP_DISCOVERY_PROGRESS", stage }
 *     stage is "OPENING_FACEBOOK" then "READING", pushed live from
 *     background.js's runManagerGroupDiscovery() as it happens.
 *   extension -> page: { type: "FLIP_GROUP_DISCOVERY_RESULT", ok, token?,
 *     expiresAt?, error? } -- the final outcome.
 */
const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);

window.addEventListener("message", (event) => {
  if (event.source !== window || !ALLOWED_ORIGINS.has(event.origin)) return;
  if (event.data?.type !== "FLIP_GROUP_DISCOVERY_REQUEST") return;
  window.postMessage({ type: "FLIP_GROUP_DISCOVERY_ACK" }, event.origin);
  try {
    chrome.runtime.sendMessage({ type: "RUN_MANAGER_GROUP_DISCOVERY" }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        window.postMessage({ type: "FLIP_GROUP_DISCOVERY_RESULT", ok: false, error: normalizeRuntimeError(runtimeError) }, event.origin);
        return;
      }
      window.postMessage({ type: "FLIP_GROUP_DISCOVERY_RESULT", ...publicResult(response) }, event.origin);
    });
  } catch (error) {
    window.postMessage({ type: "FLIP_GROUP_DISCOVERY_RESULT", ok: false, error: normalizeRuntimeError(error) }, event.origin);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "GROUP_DISCOVERY_PROGRESS") return undefined;
  window.postMessage({ type: "FLIP_GROUP_DISCOVERY_PROGRESS", stage: message.stage }, window.location.origin);
  return undefined;
});

function publicResult(value) {
  return {
    ok: value?.ok === true,
    token: typeof value?.token === "string" ? value.token : undefined,
    expiresAt: typeof value?.expiresAt === "string" ? value.expiresAt : undefined,
    error: typeof value?.error === "string" ? value.error : undefined,
  };
}

function normalizeRuntimeError(error) {
  const message = error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(error || "");
  return /extension context invalidated/i.test(message) ? "EXTENSION_CONTEXT_INVALIDATED" : message.slice(0, 300) || "EXTENSION_RUNTIME_FAILED";
}
