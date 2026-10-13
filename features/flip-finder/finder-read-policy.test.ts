import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FINDER_REVIEW_MEMBERSHIP_OR_FILTER, FINDER_REVIEW_UNKNOWN_FIELDS, SOURCE_SCAN_READ_LIMIT, ARCHIVE_PAGE_SIZE_MAX } from "./finder-read-policy.ts";
import { visibleMembership } from "./membership-reconciliation.ts";

test("the server-side membership filter covers every field the shared evaluation can mark unknown", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "filter-evaluation.ts"), "utf8");
  const marked = new Set([...source.matchAll(/markUnknown\("([A-Za-z]+)"\)/gu)].map((match) => match[1]));
  for (const call of source.matchAll(/evaluateKnownChoice\([^,]+,[^,]+,\s*"([A-Za-z]+)"/gu)) marked.add(call[1]);
  marked.add("buildingType");
  for (const field of marked) assert.ok((FINDER_REVIEW_UNKNOWN_FIELDS as readonly string[]).includes(field), `unknown_${field} must be part of the visible-membership filter`);
});

test("the PostgREST filter is the server-side form of visibleMembership()", () => {
  const clauses = FINDER_REVIEW_MEMBERSHIP_OR_FILTER.split(",");
  assert.equal(clauses[0], "is_current_match.eq.true");
  assert.ok(clauses.includes('match_reasons.cs.["review"]'));
  assert.ok(clauses.every((clause) => !clause.includes(",")));
  // Every legacy unknown_* REVIEW row that visibleMembership() shows is selected by one clause.
  for (const field of FINDER_REVIEW_UNKNOWN_FIELDS) {
    assert.equal(visibleMembership({ isCurrentMatch: false, matchReasons: [`unknown_${field}`] }), true);
    assert.ok(clauses.includes(`match_reasons.cs.["unknown_${field}"]`));
  }
  assert.equal(visibleMembership({ isCurrentMatch: false, matchReasons: ["max_price_per_sqm"] }), false);
});

test("read limits stay bounded", () => {
  assert.ok(SOURCE_SCAN_READ_LIMIT <= 100);
  assert.ok(ARCHIVE_PAGE_SIZE_MAX <= 100);
});
