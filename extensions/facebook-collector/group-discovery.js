"use strict";

/**
 * "Wykryj grupy nieruchomościowe": runs only on Facebook's own "Twoje grupy"
 * page (https://www.facebook.com/groups/joins/, matched in manifest.json).
 * Extracts every group link Facebook actually rendered, with the name
 * Facebook itself displays for it -- never a guess, never a screenshot/OCR
 * read. A link the page renders with no readable text is reported with
 * name=null, which the server-side classifier (features/facebook-groups/
 * discovery.ts) routes to WYMAGA_WERYFIKACJI, never treats as ready to
 * import automatically ("no activation from a screenshot name alone").
 *
 * UNVERIFIED AGAINST A LIVE FACEBOOK SESSION: the exact selector/markup
 * Facebook's "Twoje grupy" page uses has not been confirmed against a real,
 * authenticated facebook.com response in this environment -- exactly the
 * same class of limitation already documented for gallery ROOT_AMBIGUOUS.
 * extractGroupCandidatesFromDom itself is generic (any /groups/<id>/ anchor
 * with visible text) and unit-tested against constructed fake DOM
 * structures, but a controlled live run is needed to confirm it actually
 * finds Facebook's real group links on that specific page.
 */
(function () {
  const GROUP_LINK_PATTERN = /^\/groups\/([^/?#]+)\/?$/i;
  const MAX_DISCOVERED_GROUPS = 200;

  function extractGroupCandidatesFromDom(root) {
    return inspectGroupCandidatesFromDom(root).candidates;
  }

  function inspectGroupCandidatesFromDom(root) {
    const anchors = root.querySelectorAll("a[href]");
    const seen = new Set();
    const candidates = [];
    let rejected = 0;
    let duplicates = 0;
    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute?.("href");
      if (!href) { rejected += 1; continue; }
      let url;
      try {
        url = new URL(href, "https://www.facebook.com");
      } catch {
        rejected += 1;
        continue;
      }
      if (!["www.facebook.com", "facebook.com", "m.facebook.com"].includes(url.hostname.toLocaleLowerCase())) { rejected += 1; continue; }
      const match = url.pathname.match(GROUP_LINK_PATTERN);
      if (!match || !/^[a-z0-9._-]+$/i.test(match[1])) { rejected += 1; continue; }
      const identifier = match[1];
      const dedupeKey = identifier.toLocaleLowerCase("en-US");
      if (seen.has(dedupeKey)) { duplicates += 1; continue; }
      seen.add(dedupeKey);
      if (candidates.length >= MAX_DISCOVERED_GROUPS) { rejected += 1; continue; }
      const rawText = accessibleName(anchor);
      const name = normalizeName(rawText, identifier);
      candidates.push({ url: `https://www.facebook.com/groups/${identifier}/`, name });
    }
    return { candidates, diagnostics: { examined: anchors.length, accepted: candidates.length, rejected, duplicates, loadedOnly: true } };
  }

  function accessibleName(anchor) {
    const get = (name) => typeof anchor.getAttribute === "function" ? anchor.getAttribute(name) : anchor[name] || null;
    const aria = get("aria-label");
    if (typeof aria === "string" && aria.trim()) return aria;
    const title = get("title");
    if (typeof title === "string" && title.trim()) return title;
    return typeof anchor.textContent === "string" ? anchor.textContent : "";
  }

  function normalizeName(rawText, identifier) {
    const trimmed = rawText.replace(/\s+/g, " ").trim();
    if (!trimmed) return null;
    // A link Facebook renders with nothing but its own numeric ID as text
    // (e.g. an image-only tile whose accessible name happens to be the raw
    // URL fragment) is not a real, human-authored name.
    if (trimmed === identifier) return null;
    return trimmed.slice(0, 200);
  }

  function buildDiscoveryPayload(candidates) {
    const discoveredAt = new Date().toISOString();
    return candidates.map((candidate) => ({ url: candidate.url, name: candidate.name, discoveredAt }));
  }

  async function runGroupDiscovery(root = document) {
    const inspected = inspectGroupCandidatesFromDom(root);
    const candidates = inspected.candidates;
    const payload = buildDiscoveryPayload(candidates);
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "REPORT_DISCOVERED_GROUPS", candidates: payload, diagnostics: inspected.diagnostics }, (response) => resolve(response));
      });
    }
    return { ok: false, error: "NO_RUNTIME" };
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("load", () => { void runGroupDiscovery(); });
  }

  // Manual trigger for the popup's "Wykryj grupy nieruchomości" button: the
  // same scan this content script already runs automatically on page load,
  // re-run on demand (e.g. after scrolling to load more groups, or if the
  // automatic run was missed). Never imports/activates anything itself --
  // identical behavior to the automatic run, just explicitly requested.
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message?.type !== "RUN_GROUP_DISCOVERY") return undefined;
      // Passes runGroupDiscovery()'s own result straight through (already
      // { ok, result } / { ok: false, error } from background.js's
      // REPORT_DISCOVERED_GROUPS handler) rather than wrapping it again.
      void runGroupDiscovery().then((result) => respond(result)).catch((error) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    });
  }

  // Test-only export, exactly like content.js's own pattern -- `module`
  // never exists in the browser extension context.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractGroupCandidatesFromDom, inspectGroupCandidatesFromDom, buildDiscoveryPayload, normalizeName, accessibleName };
  }
})();
