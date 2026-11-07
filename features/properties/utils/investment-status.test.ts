import assert from "node:assert/strict";
import test from "node:test";

import { INVESTMENT_STATUSES, INVESTMENT_STATUS_LABELS, isInvestmentStatus } from "./investment-status.ts";

test("only purchased and later property stages are investments", () => {
  assert.deepEqual(INVESTMENT_STATUSES, ["acquired", "renovation", "listed", "sold"]);
  for (const status of INVESTMENT_STATUSES) {
    assert.equal(isInvestmentStatus(status), true);
    assert.ok(INVESTMENT_STATUS_LABELS[status]);
  }
  assert.equal(isInvestmentStatus("draft"), false);
  assert.equal(isInvestmentStatus("analysis"), false);
});

test("investment status labels are readable in Polish", () => {
  assert.equal(INVESTMENT_STATUS_LABELS.acquired, "Kupiona");
  assert.equal(INVESTMENT_STATUS_LABELS.renovation, "Remont");
  assert.equal(INVESTMENT_STATUS_LABELS.listed, "W sprzedaży");
  assert.equal(INVESTMENT_STATUS_LABELS.sold, "Sprzedana");
});
