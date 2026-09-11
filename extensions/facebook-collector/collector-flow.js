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
  root.FlipCollectorFlow = { collectorOutcome, createStageTimeline, searchFailureDisposition };
})(globalThis);
