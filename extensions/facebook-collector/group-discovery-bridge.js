(() => {
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
 *     expiresAt?, error?, diagnostics? } -- the final outcome. diagnostics
 *     (page URL, links examined/accepted/rejected, why an empty result is
 *     empty) is echoed straight through from the server's own response to
 *     the same discovery POST, so a genuinely empty result is explainable
 *     without guessing.
 *
 * Injection: the manifest's static content_scripts entry only ever fires on
 * a real browser navigation (document_start) -- never on the SPA/pushState
 * transition Next.js's own <Link> actually performs when the operator
 * reaches this page from within the already-loaded app (e.g. the Watcher
 * inbox's "Obserwowane grupy" button). That left this listener simply never
 * registered for the single most common way a real user actually arrives
 * here -- the root cause behind "the extension never responds", not a
 * session or installation problem at all. background.js's own
 * webNavigation.onHistoryStateUpdated listener now additionally injects
 * this exact file via chrome.scripting.executeScript on every such
 * SPA transition, so it is guarded here to be idempotent against running
 * twice on the same page (the static content_scripts entry AND a dynamic
 * re-injection both firing for one navigation) -- exactly the same
 * globalThis-keyed guard bootstrap.js already uses for its own,
 * structurally identical multiple-injection risk. The whole file is wrapped
 * in an IIFE (also matching bootstrap.js) because a bare top-level const/let
 * re-executed a second time in the same page throws
 * "Identifier has already been declared" -- without the IIFE, the second
 * injection wouldn't just skip re-registering, it would throw before the
 * guard check ever ran.
 */
const BRIDGE_STATE_KEY = "__flipGroupDiscoveryBridgeInjected";

if (!globalThis[BRIDGE_STATE_KEY]) {
  globalThis[BRIDGE_STATE_KEY] = true;

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
}

function publicResult(value) {
  return {
    ok: value?.ok === true,
    token: typeof value?.token === "string" ? value.token : undefined,
    expiresAt: typeof value?.expiresAt === "string" ? value.expiresAt : undefined,
    error: typeof value?.error === "string" ? value.error : undefined,
    // Lets the Manager page explain a real, empty discovery result (page
    // URL, links examined/accepted/rejected, why nothing was found) instead
    // of a bare "no groups" with no way to tell a wrong-page/DOM-change
    // problem apart from a genuinely empty groups list.
    diagnostics: value?.diagnostics && typeof value.diagnostics === "object" ? value.diagnostics : undefined,
  };
}

function normalizeRuntimeError(error) {
  const message = error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(error || "");
  return /extension context invalidated/i.test(message) ? "EXTENSION_CONTEXT_INVALIDATED" : message.slice(0, 300) || "EXTENSION_RUNTIME_FAILED";
}
})();
