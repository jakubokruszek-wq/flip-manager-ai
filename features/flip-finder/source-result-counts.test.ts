import assert from "node:assert/strict";
import test from "node:test";

import { countFinderResultsBySource } from "./source-result-counts.ts";

const row = (source: "gratka" | "olx" | "domiporta") => ({ source });

test("Finder source totals use MATCHED and REVIEW canonical rows, including active zero-result sources", () => {
  const counts = countFinderResultsBySource(
    [row("gratka")],
    [row("olx"), row("olx")],
  );

  assert.deepEqual(counts.bySource.gratka, { matched: 1, review: 0 });
  assert.deepEqual(counts.bySource.olx, { matched: 0, review: 2 });
  assert.deepEqual(counts.bySource.domiporta, { matched: 0, review: 0 });
  assert.deepEqual(counts.total, { matched: 1, review: 2 });
  assert.equal(
    counts.total.matched,
    Object.values(counts.bySource).reduce((sum, source) => sum + source.matched, 0),
  );
  assert.equal(
    counts.total.review,
    Object.values(counts.bySource).reduce((sum, source) => sum + source.review, 0),
  );
});

test("cross-portal property card counts once in totals and once in each represented portal", () => {
  const counts = countFinderResultsBySource(
    [{ id: "unit-1", source: "gratka", linkedListings: [{ source: "morizon" }, { source: "nieruchomosci_online" }] }],
    [{ id: "unit-2", source: "olx", linkedListings: [{ source: "otodom" }] }],
  );
  assert.deepEqual(counts.total, { matched: 1, review: 1 });
  assert.deepEqual(counts.bySource.gratka, { matched: 1, review: 0 });
  assert.deepEqual(counts.bySource.morizon, { matched: 1, review: 0 });
  assert.deepEqual(counts.bySource.nieruchomosci_online, { matched: 1, review: 0 });
  assert.deepEqual(counts.bySource.olx, { matched: 0, review: 1 });
  assert.deepEqual(counts.bySource.otodom, { matched: 0, review: 1 });
});
