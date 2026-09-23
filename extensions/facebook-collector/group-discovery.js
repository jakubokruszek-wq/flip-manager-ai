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

  function extractGroupCandidatesFromDom(root) {
    const anchors = root.querySelectorAll("a[href]");
    const seen = new Set();
    const candidates = [];
    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute?.("href");
      if (!href) continue;
      let url;
      try {
        url = new URL(href, "https://www.facebook.com");
      } catch {
        continue;
      }
      if (url.hostname !== "www.facebook.com" && url.hostname !== "facebook.com") continue;
      const match = url.pathname.match(GROUP_LINK_PATTERN);
      if (!match) continue;
      const identifier = match[1];
      if (seen.has(identifier)) continue;
      seen.add(identifier);
      const rawText = typeof anchor.textContent === "string" ? anchor.textContent : "";
      const name = normalizeName(rawText, identifier);
      candidates.push({ url: `https://www.facebook.com/groups/${identifier}/`, name });
    }
    return candidates;
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
    const candidates = extractGroupCandidatesFromDom(root);
    const payload = buildDiscoveryPayload(candidates);
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "REPORT_DISCOVERED_GROUPS", candidates: payload }, (response) => resolve(response));
      });
    }
    return { ok: false, error: "NO_RUNTIME" };
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("load", () => { void runGroupDiscovery(); });
  }

  // Test-only export, exactly like content.js's own pattern -- `module`
  // never exists in the browser extension context.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractGroupCandidatesFromDom, buildDiscoveryPayload, normalizeName };
  }
})();
