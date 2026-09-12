import assert from "node:assert/strict";
import test from "node:test";
import { nextWorkspaceTab } from "./workspace-tabs.ts";

test("workspace tabs support wrapped arrow navigation and Home/End", () => {
  assert.equal(nextWorkspaceTab("OVERVIEW", "ArrowLeft"), "AUDIT");
  assert.equal(nextWorkspaceTab("AUDIT", "ArrowRight"), "OVERVIEW");
  assert.equal(nextWorkspaceTab("MARKET", "ArrowDown"), "ECONOMICS");
  assert.equal(nextWorkspaceTab("RISKS", "Home"), "OVERVIEW");
  assert.equal(nextWorkspaceTab("OVERVIEW", "End"), "AUDIT");
  assert.equal(nextWorkspaceTab("MARKET", "Tab"), null);
});
