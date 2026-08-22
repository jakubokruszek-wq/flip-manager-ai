import assert from "node:assert/strict";
import test from "node:test";
import { aggregateFacebookJobStatus, orderFacebookGroups, planFacebookGroupJobs, type WatchedFacebookGroup } from "./multi-group.ts";

const groups: WatchedFacebookGroup[] = [
  { id: "normal", name: "Normal", url: "https://www.facebook.com/groups/normal", priority: "normal", createdAt: "2026-01-01T00:00:00Z" },
  { id: "high-new", name: "High new", url: "https://www.facebook.com/groups/high-new", priority: "high", createdAt: "2026-01-02T00:00:00Z" },
  { id: "high-old", name: "High old", url: "https://www.facebook.com/groups/high-old", priority: "high", createdAt: "2026-01-01T00:00:00Z" },
];

test("orders enabled groups by business priority then creation time", () => {
  assert.deepEqual(orderFacebookGroups(groups).map((group) => group.id), ["high-old", "high-new", "normal"]);
});

test("plans one independently bound job per watched group", () => {
  const plans = planFacebookGroupJobs("filter", "run", groups.slice(0, 2));
  assert.equal(plans.length, 2);
  assert.ok(plans.every((plan) => plan.runId === "run" && plan.groupSnapshot.length === 1));
  assert.equal(new Set(plans.map((plan) => plan.group.id)).size, 2);
  assert.equal(new Set(plans.map((plan) => plan.idempotencyKey)).size, 2);
});

test("zero groups creates no queue plans", () => assert.deepEqual(planFacebookGroupJobs("filter", "run", []), []));
test("one group remains backward compatible", () => assert.equal(planFacebookGroupJobs("filter", "run", [groups[0]]).length, 1));
test("run status is completed only when all jobs complete", () => assert.equal(aggregateFacebookJobStatus(["completed", "completed"]), "completed"));
test("one group failure produces partial without blocking a completed group", () => assert.equal(aggregateFacebookJobStatus(["completed", "failed"]), "partial"));
