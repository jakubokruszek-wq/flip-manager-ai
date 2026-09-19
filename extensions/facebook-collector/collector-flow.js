(function installCollectorFlow(root) {
  "use strict";
  if (root.FlipCollectorFlow) return;
  function createStageTimeline(now = () => Date.now()) {
    const stages = new Map();
    return {
      start(stage) { stages.set(stage, { stage, startedAt: new Date(now()).toISOString(), finishedAt: null, elapsedMs: null, status: "RUNNING", errorCode: null }); },
      finish(stage, status = "PASS", errorCode = null) {
        const finished = now();
        const current = stages.get(stage) || { stage, startedAt: new Date(finished).toISOString() };
        stages.set(stage, { ...current, finishedAt: new Date(finished).toISOString(), elapsedMs: Math.max(0, finished - Date.parse(current.startedAt)), status, errorCode });
      },
      snapshot() { return [...stages.values()].slice(0, 24); },
    };
  }
  function searchFailureDisposition(code) { return code === "SOURCE_COLLECTION_DEADLINE_EXCEEDED" ? "STOP" : "CONTINUE"; }
  function collectorOutcome(mainFeedSucceeded, searchRuns, plannedQueries) {
    if (!mainFeedSucceeded) return "FAILED";
    const runs = Array.isArray(searchRuns) ? searchRuns : [];
    return runs.length === plannedQueries && runs.every((run) => run?.executed === true && run?.status === "HEALTHY") ? "COMPLETE" : "PARTIAL";
  }

  /**
   * Acquisition modes. NETWORK_FIRST relies on the structured/network main
   * feed alone; SEARCH_ENABLED additionally runs the per-query group search.
   * Production telemetry measured the search phase at ~89% of scan runtime
   * with zero captured posts across two independent scans, so NETWORK_FIRST
   * is the default. The search path is retained rather than deleted so it can
   * be re-enabled instantly for recall comparison or fallback.
   */
  const ACQUISITION_MODES = { NETWORK_FIRST: "NETWORK_FIRST", SEARCH_ENABLED: "SEARCH_ENABLED" };

  function resolveAcquisitionMode(config) {
    return config && config.searchPhaseEnabled === true ? ACQUISITION_MODES.SEARCH_ENABLED : ACQUISITION_MODES.NETWORK_FIRST;
  }

  function isSearchPhaseEnabled(config) {
    return resolveAcquisitionMode(config) === ACQUISITION_MODES.SEARCH_ENABLED;
  }

  /**
   * Feed depth. CURRENT_DEPTH reproduces today's budget exactly, including the
   * reserve held back to fund the search phase. DEEPER_NETWORK_FEED is only
   * reachable once search is disabled: it returns that reserve to the feed and
   * raises the scroll/post ceilings. It never forces extra scrolling — the
   * existing natural stop conditions still terminate the loop, so the deeper
   * ceiling is consumed only when the group genuinely has more fresh content.
   */
  const FEED_DEPTH_MODES = { CURRENT_DEPTH: "CURRENT_DEPTH", DEEPER_NETWORK_FEED: "DEEPER_NETWORK_FEED" };

  function resolveFeedDepth(input) {
    const limits = (input && input.limits) || {};
    const searchReserveMs = Math.max(0, Number(input && input.searchReserveMs) || 0);
    const hardTimeBudgetMs = Math.max(0, Number(limits.hardTimeBudgetMs) || 0);
    const searchEnabled = Boolean(input && input.searchEnabled);
    const requested = input && input.mode === FEED_DEPTH_MODES.DEEPER_NETWORK_FEED ? FEED_DEPTH_MODES.DEEPER_NETWORK_FEED : FEED_DEPTH_MODES.CURRENT_DEPTH;
    // The reserve exists only to fund search; holding it while search runs is
    // what keeps CURRENT_DEPTH identical to today's production behaviour.
    const mode = searchEnabled ? FEED_DEPTH_MODES.CURRENT_DEPTH : requested;
    if (mode === FEED_DEPTH_MODES.CURRENT_DEPTH) {
      return { mode, minScrolls: limits.minScrolls, maxScrolls: limits.maxScrolls, maxPosts: limits.maxPosts, budgetMs: Math.max(0, hardTimeBudgetMs - searchReserveMs) };
    }
    return { mode, minScrolls: limits.minScrolls, maxScrolls: Math.max(Number(limits.maxScrolls) || 0, 45), maxPosts: Math.max(Number(limits.maxPosts) || 0, 80), budgetMs: hardTimeBudgetMs };
  }

  root.FlipCollectorFlow = { ACQUISITION_MODES, FEED_DEPTH_MODES, collectorOutcome, createStageTimeline, isSearchPhaseEnabled, resolveAcquisitionMode, resolveFeedDepth, searchFailureDisposition };
})(globalThis);
