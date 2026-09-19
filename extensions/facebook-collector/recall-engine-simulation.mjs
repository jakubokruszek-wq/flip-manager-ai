/*
 * LOCAL SIMULATION ONLY. No live Facebook access. This script exercises the
 * real decision functions (waitUntilFeedProgress, mergeRecords,
 * evaluateCurrentDepthSufficiency, evaluateDeeperFeedTransition,
 * advanceAgeStreak/isOldAgeStopReached) against small, fabricated sample
 * sequences chosen only to be fast to run and to exercise each code path.
 * The wait durations below are NOT measurements of real Facebook timing and
 * must never be read as production performance numbers — they only show
 * that the condition waiter exits early on real evidence instead of always
 * consuming its full bound, and that the sufficiency/transition decisions
 * fire on the intended scenarios.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

global.globalThis.FlipFacebookCollectorCore = {};
global.window = { addEventListener: () => {} };
global.location = { origin: "https://www.facebook.com", href: "https://www.facebook.com/groups/example/" };
global.document = { addEventListener: () => {}, readyState: "complete", querySelectorAll: () => [] };
global.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {} } };
require("./collector-core.js");
const core = globalThis.FlipFacebookCollectorCore;
const { waitUntilFeedProgress } = require("./content.js");

function record(postId, layer) {
  return { postId, permalink: `https://www.facebook.com/groups/example/posts/${postId}/`, sourceId: "example", sourceType: "GROUP", author: null, text: null, publishedAt: null, timestampText: null, media: [], discoveryLayers: [layer], firstSeenIteration: 0 };
}

async function simulateScrollLoop({ label, steps, oldFixedWaitMs }) {
  let records = [];
  let ageStreak = core.initialAgeStreakState();
  let waitCycles = 0;
  let totalConditionWaitMs = 0;
  let scrollCount = 0;
  const oldTotalWaitMs = steps.length * oldFixedWaitMs;

  for (const step of steps) {
    const before = records.length;
    records = core.mergeRecords([...records, ...step.newPosts.map((id) => record(id, "DOM"))]);
    const added = records.length - before;
    ageStreak = core.advanceAgeStreak(ageStreak, step.newAgeZones ?? Array.from({ length: added }, () => "FRESH"));
    scrollCount += 1;
    waitCycles += 1;
    let pollsBeforeProgress = step.pollsBeforeProgress ?? 0;
    const outcome = await waitUntilFeedProgress({
      sample: () => {
        pollsBeforeProgress -= 1;
        const progressed = pollsBeforeProgress <= 0;
        return { postCount: records.length + (progressed ? 1 : 0), networkCount: 0, visibleCount: 0, scrollHeight: 0, cardCount: 0 };
      },
      timeoutMs: oldFixedWaitMs,
      pollMs: 20,
      stableChecks: 2,
    });
    totalConditionWaitMs += outcome.waitedMs;
  }

  const sufficiency = core.evaluateCurrentDepthSufficiency({
    uniqueCanonicalPosts: records.length,
    capturedPosts: records.length,
    freshPosts: ageStreak.freshPostsSeen,
    duplicateCount: steps.reduce((sum, step) => sum + (step.duplicates ?? 0), 0),
    visibleCards: records.length + 1,
    scrollCount,
  });
  const transition = core.evaluateDeeperFeedTransition({
    scanMode: "FAST_REPEAT", searchMode: false,
    stopReason: core.isOldAgeStopReached(ageStreak, scrollCount, undefined) ? "TEN_CONSECUTIVE_OLDER_THAN_72H" : "NO_NEW_POSTS_AND_CARDS_3_SCROLLS",
    aborted: false,
    metrics: { uniqueCanonicalPosts: records.length, capturedPosts: records.length, freshPosts: ageStreak.freshPostsSeen, duplicateCount: steps.reduce((sum, step) => sum + (step.duplicates ?? 0), 0), visibleCards: records.length + 1, scrollCount },
  });

  console.log(`\n=== ${label} (LOCAL SIMULATION ONLY) ===`);
  console.log(`  scroll iterations: ${scrollCount}`);
  console.log(`  wait cycles: ${waitCycles}`);
  console.log(`  unique posts discovered (this pass): ${records.length}`);
  console.log(`  old fixed-wait total (simulated, ${oldFixedWaitMs}ms/iteration): ${oldTotalWaitMs}ms`);
  console.log(`  new condition-wait total (simulated): ${totalConditionWaitMs}ms`);
  console.log(`  simulated wait reduction: ${oldTotalWaitMs > 0 ? Math.round((1 - totalConditionWaitMs / oldTotalWaitMs) * 100) : 0}%`);
  console.log(`  sufficiency: ${sufficiency.sufficient} (${sufficiency.reasons.join(", ")})`);
  console.log(`  deeper feed triggered: ${transition.triggerDeeper} (${transition.reason})`);
  return { records, ageStreak, scrollCount, totalConditionWaitMs, oldTotalWaitMs, sufficiency, transition };
}

async function main() {
  // SCENARIO 1: healthy feed, many fresh unique posts, quick progress each scroll.
  await simulateScrollLoop({
    label: "SCENARIO 1: healthy feed (many fresh unique posts, fast progress)",
    oldFixedWaitMs: 1600,
    steps: Array.from({ length: 18 }, (_, index) => ({ newPosts: [`h${index}`], pollsBeforeProgress: 1 })),
  });

  // SCENARIO 2: sparse feed, few posts; deeper feed discovers useful new posts.
  const currentDepth = await simulateScrollLoop({
    label: "SCENARIO 2a: sparse current-depth (few posts, early stop)",
    oldFixedWaitMs: 1600,
    steps: [
      { newPosts: ["s1"], pollsBeforeProgress: 1 },
      { newPosts: ["s2"], pollsBeforeProgress: 1 },
      { newPosts: [], pollsBeforeProgress: 30 },
      { newPosts: [], pollsBeforeProgress: 30 },
    ],
  });
  const deeper = await simulateScrollLoop({
    label: "SCENARIO 2b: DEEPER_NETWORK_FEED continuing from current-depth's records (discovers new posts)",
    oldFixedWaitMs: 1600,
    steps: [
      { newPosts: ["s3"], pollsBeforeProgress: 1 },
      { newPosts: ["s4", "s5"], pollsBeforeProgress: 1 },
    ],
  });
  // Prove continuity: merging the deeper pass's discoveries onto current-depth's own records never drops or duplicates identity.
  const merged = core.mergeRecords([...currentDepth.records, ...deeper.records]);
  console.log(`  [2] combined unique posts across both passes: ${merged.length} (current-depth ${currentDepth.records.length} + deeper found ${deeper.records.length - 0} new, no duplicates)`);

  // SCENARIO 3: duplicate-heavy feed.
  await simulateScrollLoop({
    label: "SCENARIO 3: duplicate-heavy feed (same few posts rediscovered repeatedly)",
    oldFixedWaitMs: 800,
    steps: [
      { newPosts: ["d1", "d2", "d3"], pollsBeforeProgress: 1 },
      { newPosts: ["d1", "d2", "d3"], pollsBeforeProgress: 30, duplicates: 3 },
      { newPosts: ["d1", "d2", "d3"], pollsBeforeProgress: 30, duplicates: 3 },
      { newPosts: ["d1", "d2", "d3"], pollsBeforeProgress: 30, duplicates: 3 },
    ],
  });

  // SCENARIO 4: old frontier reached (Date/Frontier hard block).
  await simulateScrollLoop({
    label: "SCENARIO 4: old frontier reached (10 consecutive posts older than 72h)",
    oldFixedWaitMs: 1600,
    steps: [
      { newPosts: ["f1"], pollsBeforeProgress: 1, newAgeZones: ["FRESH"] },
      ...Array.from({ length: 10 }, (_, index) => ({ newPosts: [`old${index}`], pollsBeforeProgress: 1, newAgeZones: ["OLD"] })),
    ],
  });

  console.log("\nAll figures above are LOCAL SIMULATION ONLY — not measured Facebook performance.");
}

main();
