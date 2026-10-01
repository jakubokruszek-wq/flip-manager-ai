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
    const namesFound = candidates.filter((candidate) => candidate.name !== null).length;
    return {
      candidates,
      diagnostics: {
        // The page URL this scan actually ran on: proves discovery ran on
        // the page the operator expected, without needing to guess from a
        // silent zero-result whether the wrong Facebook page loaded.
        pageUrl: typeof location !== "undefined" ? String(location.href).slice(0, 500) : null,
        examined: anchors.length,
        accepted: candidates.length,
        namesFound,
        rejected,
        duplicates,
        loadedOnly: true,
        // A concrete, human-readable reason for an empty result -- "found
        // nothing" alone does not say whether the page had no /groups/
        // links at all (wrong page, or Facebook's markup changed) or every
        // link it did have was already known/rejected.
        reason: candidates.length > 0
          ? null
          : anchors.length === 0
            ? "NO_LINKS_ON_PAGE"
            : rejected > 0 && rejected === anchors.length
              ? "NO_GROUP_LINKS_AMONG_EXAMINED_ANCHORS"
              : "NO_NEW_GROUP_LINKS_FOUND",
      },
    };
  }

  function accessibleName(anchor) {
    const get = (name) => typeof anchor.getAttribute === "function" ? anchor.getAttribute(name) : anchor[name] || null;
    const aria = get("aria-label");
    if (typeof aria === "string" && aria.trim()) return aria;
    const title = get("title");
    if (typeof title === "string" && title.trim()) return title;
    return typeof anchor.textContent === "string" ? anchor.textContent : "";
  }

  // Real, now-proven production bug: Facebook's own group-tile markup often
  // wraps both the group's real name and its own "Ostatnia aktywność/wizyta
  // ... temu" (last activity/last visit) subtitle inside the exact same
  // anchor, with no separating whitespace between the two text nodes when
  // read back via textContent. A real discovery run reached the registry
  // with names like "...WynajemOstatnia aktywność 8 min temu" -- the
  // trailing, Facebook-authored subtitle glued directly onto the real name.
  // That subtitle is never part of the group's own name, so it is stripped
  // before anything else; unanchored at the start (it needs to match even
  // with zero preceding whitespace/punctuation) but anchored at the end,
  // since it is always Facebook's own trailing addition, never a prefix.
  const TRAILING_FACEBOOK_ACTIVITY_SUFFIX = /Ostatnia\s+(?:aktywność|wizyta)\s.*$/isu;

  function normalizeName(rawText, identifier) {
    const withoutActivitySuffix = rawText.replace(TRAILING_FACEBOOK_ACTIVITY_SUFFIX, "");
    const trimmed = withoutActivitySuffix.replace(/\s+/g, " ").trim();
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

  const MAX_SCROLL_ATTEMPTS = 20;
  const STABLE_ROUNDS_REQUIRED = 2;
  const SCROLL_WAIT_MS = 800;

  /**
   * Facebook's "Twoje grupy" page lazy-loads groups as the user scrolls, so a
   * single, immediate DOM read only ever sees the first rendered page. This
   * repeatedly scrolls and re-inspects the DOM until the discovered-candidate
   * count stops growing for `stableRoundsRequired` consecutive rounds (or
   * `maxAttempts` is hit, so a page that never stabilizes -- e.g. an infinite
   * unrelated feed -- cannot hang discovery forever). scrollFn/waitFn are
   * injectable so this is unit-testable without real browser timers/scrolling.
   */
  async function scrollUntilStable(root, { scrollFn, waitFn, maxAttempts = MAX_SCROLL_ATTEMPTS, stableRoundsRequired = STABLE_ROUNDS_REQUIRED } = {}) {
    let previousCount = inspectGroupCandidatesFromDom(root).candidates.length;
    let stableRounds = 0;
    let attempts = 0;
    while (attempts < maxAttempts && stableRounds < stableRoundsRequired) {
      scrollFn();
      await waitFn();
      attempts += 1;
      const currentCount = inspectGroupCandidatesFromDom(root).candidates.length;
      stableRounds = currentCount === previousCount ? stableRounds + 1 : 0;
      previousCount = currentCount;
    }
    const final = inspectGroupCandidatesFromDom(root);
    return { ...final, diagnostics: { ...final.diagnostics, scrollAttempts: attempts, stabilized: stableRounds >= stableRoundsRequired, loadedOnly: false } };
  }

  function defaultScrollFn() { window.scrollTo(0, document.body.scrollHeight); }
  function defaultWaitFn() { return new Promise((resolve) => window.setTimeout(resolve, SCROLL_WAIT_MS)); }

  const INITIAL_RENDER_MAX_ATTEMPTS = 15;

  /**
   * Facebook is a heavy client-rendered SPA: this content script can run
   * (document_idle) before React has actually painted the group list, so an
   * immediate read can see zero links even on the right page with intact
   * selectors. Polls for at least one candidate to appear before starting
   * the scroll loop, bounded so a page that genuinely has none (wrong page,
   * or Facebook's markup changed) still reports a real, timely empty result
   * rather than hanging.
   */
  async function waitForInitialRender(root, { waitFn, maxAttempts = INITIAL_RENDER_MAX_ATTEMPTS } = {}) {
    let attempts = 0;
    while (attempts < maxAttempts) {
      if (inspectGroupCandidatesFromDom(root).candidates.length > 0) return { attempts, rendered: true };
      await waitFn();
      attempts += 1;
    }
    return { attempts, rendered: false };
  }

  async function runGroupDiscovery(root = document, { skipTabOpen = false, scroll = true } = {}) {
    const canScrollLive = scroll && typeof window !== "undefined" && typeof window.scrollTo === "function";
    let initialRender = null;
    if (canScrollLive) initialRender = await waitForInitialRender(root, { waitFn: defaultWaitFn });
    const inspected = canScrollLive
      ? await scrollUntilStable(root, { scrollFn: defaultScrollFn, waitFn: defaultWaitFn })
      : inspectGroupCandidatesFromDom(root);
    const candidates = inspected.candidates;
    const payload = buildDiscoveryPayload(candidates);
    const diagnostics = initialRender
      ? { ...inspected.diagnostics, initialRenderAttempts: initialRender.attempts, initialRenderTimedOut: !initialRender.rendered }
      : inspected.diagnostics;
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "REPORT_DISCOVERED_GROUPS", candidates: payload, diagnostics, skipTabOpen }, (response) => resolve(response));
      });
    }
    return { ok: false, error: "NO_RUNTIME" };
  }

  // popup.js's discoverGroups() now retries by explicitly re-injecting this
  // exact file (chrome.scripting.executeScript) when the content script
  // does not answer at all -- the same recovery already used for
  // collector-core.js/content.js (background.js's waitForContentScript).
  // That retry can land in the same page as an already-running copy (the
  // static content_scripts entry fired, but was merely slow to finish
  // registering its listener, not actually missing), so this guard makes a
  // second injection into the same page harmless: at most one "load"
  // listener and one onMessage listener ever end up registered.
  const GROUP_DISCOVERY_STATE_KEY = "__flipGroupDiscoveryInjected";
  if (!globalThis[GROUP_DISCOVERY_STATE_KEY]) {
    globalThis[GROUP_DISCOVERY_STATE_KEY] = true;

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
        void runGroupDiscovery(document, { skipTabOpen: message.skipTabOpen === true }).then((result) => respond(result)).catch((error) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        return true;
      });
    }
  }

  // Test-only export, exactly like content.js's own pattern -- `module`
  // never exists in the browser extension context.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { extractGroupCandidatesFromDom, inspectGroupCandidatesFromDom, buildDiscoveryPayload, normalizeName, accessibleName, scrollUntilStable, waitForInitialRender, runGroupDiscovery };
  }
})();
