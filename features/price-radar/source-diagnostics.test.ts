import assert from "node:assert/strict";
import test from "node:test";
import { classifyRadarSourceWarning, radarSourceStatusFromWarnings, sourceRejectionCountsFromWarnings } from "./source-diagnostics.ts";

test("valid candidate rejections and a clean empty search are not source failures", () => {
  const warnings = [
    "Otodom: duplicate (1)",
    "Otodom: unsupported_listing (2)",
    "INVALID_SALE_PRICE: pominięto 7 ofert bez poprawnej całkowitej ceny sprzedaży.",
    "Otodom zwrócił pustą pierwszą stronę wyników dla tego filtra.",
  ];
  assert.deepEqual(warnings.map(classifyRadarSourceWarning), [
    "candidate_rejection", "candidate_rejection", "candidate_rejection", "informational",
  ]);
  assert.equal(radarSourceStatusFromWarnings(warnings), "completed");
  assert.deepEqual(sourceRejectionCountsFromWarnings(warnings), {
    duplicate: 1,
    unsupported_listing: 2,
    invalid_sale_price: 7,
  });
});

test("a page coverage cap remains partial and never erases already accepted rows", () => {
  const warnings = ["Oferty.net: PUBLIC_SEARCH_PAGE_LIMIT_REACHED (5 pages); later pages were not requested.", "Otodom: duplicate (1)"];
  assert.equal(radarSourceStatusFromWarnings(warnings), "partial");
  assert.deepEqual(sourceRejectionCountsFromWarnings(warnings), { duplicate: 1 });
});

test("an unrecognized adapter warning remains a visible source failure", () => {
  const warning = "Domiporta: parser schema changed unexpectedly.";
  assert.equal(classifyRadarSourceWarning(warning), "source_error");
  assert.equal(radarSourceStatusFromWarnings([warning]), "failed");
});

test("only known source-level row counts are parsed; malformed counts are not accepted", () => {
  assert.deepEqual(sourceRejectionCountsFromWarnings([
    "Otodom: duplicate (not-a-number)",
    "Otodom: arbitrary_reason (9)",
    "INVALID_SALE_PRICE: pominięto 0 ofert.",
  ]), {});
});
