import assert from "node:assert/strict";
import test from "node:test";

import { planFacebookGroupJobs } from "../facebook-worker/multi-group.ts";
import { applyManagementPatch, assertAuthenticatedFacebookGroupUser, parseFacebookGroupManagementPatch, partitionWatchedFacebookGroups, safeRemovePatch } from "./management.ts";
import type { WatchedFacebookGroup } from "./types.ts";

test("four database records remain four visible UI records without pagination or canonical hiding", () => {
  const groups = [group("1", true), group("2", true), group("3", true), group("4", true)];
  const sections = partitionWatchedFacebookGroups(groups);
  assert.equal(sections.active.length + sections.inactive.length, 4);
});

test("three active and one disabled are split into explicit sections", () => {
  const sections = partitionWatchedFacebookGroups([group("1", true), group("2", true), group("3", true), group("4", false)]);
  assert.equal(sections.active.length, 3);
  assert.equal(sections.inactive.length, 1);
});

test("canonical duplicates do not hide a distinct database record", () => {
  const first = group("1", true, "https://www.facebook.com/groups/example/");
  const duplicate = group("2", false, "https://facebook.com/groups/example");
  const distinct = group("3", true, "https://www.facebook.com/groups/other/");
  const sections = partitionWatchedFacebookGroups([first, duplicate, distinct]);
  assert.deepEqual([...sections.active, ...sections.inactive].map((item) => item.id).sort(), ["1", "2", "3"]);
});

test("editing name, city, priority and enabled preserves URL and identifier", () => {
  const current = group("1", true);
  const patch = parseFacebookGroupManagementPatch({ name: "Nowa nazwa", city: "Pabianice", priority: "high", enabled: false });
  const updated = applyManagementPatch(current, patch);
  assert.equal(updated.name, "Nowa nazwa");
  assert.equal(updated.city, "Pabianice");
  assert.equal(updated.priority, "high");
  assert.equal(updated.enabled, false);
  assert.equal(updated.url, current.url);
});

test("ordinary edit rejects URL or identifier mutation", () => {
  assert.throws(() => parseFacebookGroupManagementPatch({ name: "X", city: "Łódź", priority: "normal", enabled: true, url: "https://www.facebook.com/groups/other/" }), /tylko do odczytu/);
});

test("disable excludes the group and enable includes it in the next multi-group plan", () => {
  const disabled = applyManagementPatch(group("1", true), { name: "Group 1", city: "Łódź", priority: "normal", enabled: false });
  const enabled = applyManagementPatch(disabled, { name: "Group 1", city: "Łódź", priority: "normal", enabled: true });
  const disabledPlans = planFacebookGroupJobs("filter", "run", partitionWatchedFacebookGroups([disabled]).active.map(toPlannerGroup));
  const enabledPlans = planFacebookGroupJobs("filter", "run", partitionWatchedFacebookGroups([enabled]).active.map(toPlannerGroup));
  assert.equal(disabledPlans.length, 0);
  assert.equal(enabledPlans.length, 1);
});

test("safe remove archives operationally by disabling only and preserves historical domains", () => {
  assert.deepEqual(safeRemovePatch(), { enabled: false });
  assert.equal("deleteListings" in safeRemovePatch(), false);
  assert.equal("deleteSnapshots" in safeRemovePatch(), false);
  assert.equal("deleteScans" in safeRemovePatch(), false);
});

test("unauthorized update and remove are rejected", () => {
  assert.throws(() => assertAuthenticatedFacebookGroupUser(null), /UNAUTHORIZED/);
  assert.throws(() => assertAuthenticatedFacebookGroupUser({}), /UNAUTHORIZED/);
  assert.doesNotThrow(() => assertAuthenticatedFacebookGroupUser({ id: "user-1" }));
});

function group(id: string, enabled: boolean, url = `https://www.facebook.com/groups/${id}/`): WatchedFacebookGroup {
  return { id, name: `Group ${id}`, url, city: "Łódź", district: null, neighborhood: null, priority: "normal", keywords: [], enabled, accessStatus: "CONNECTED", lastCheckedAt: null, importedPosts: 0, newToday: 0, opportunities: 0, lastError: null };
}

function toPlannerGroup(value: WatchedFacebookGroup) { return { id: value.id, name: value.name, url: value.url, priority: value.priority, createdAt: "2026-08-23T00:00:00.000Z" }; }
