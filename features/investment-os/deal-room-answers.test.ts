import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalDeal } from "./engine.ts";
import { affectedDirectors, answerOverrides, mergeAnswers, parseAnswerCommand, preserveUnchangedDirectors, roomQuestions, type AnswerInput, type DealRoomState } from "./deal-room-answers.ts";
import { lodzDeal } from "./test-fixtures/lodz-deals.ts";
const actor = "33333333-3333-4333-8333-333333333333", requestId = "44444444-4444-4444-8444-444444444444";
const state = (): DealRoomState => ({ version: 1, answers: {}, rounds: [], baselineOverrides: { holdingMonths: 5 } });
const answer = (field: string, value: number | string): AnswerInput => ({ field, kind: "VALUE", value, basis: "DECLARATION", evidenceUrl: null });
function apply(answers: AnswerInput[], base = lodzDeal()) {
  const before = buildCanonicalDeal(base), room = state(), command = parseAnswerCommand({ requestId, expectedVersion: 1, answers });
  const merged = mergeAnswers(before, room, command, actor, base.now), overrides = answerOverrides(before, room.baselineOverrides, merged);
  return { before, merged, overrides, after: preserveUnchangedDirectors(before, buildCanonicalDeal({ ...base, overrides, now: "2026-10-15T12:05:00.000Z" })) };
}
test("260k answer updates actual canonical purchase, profit and ROI without declaring legal proof", () => {
  const { before, after, merged } = apply([answer("negotiatedPrice", 260000)]);
  assert.equal(after.underwriting.result?.purchasePrice, 260000);
  assert.equal(after.facts.askingPrice.sourceValue, 300000);
  assert.equal(after.facts.askingPrice.effectiveValue, 300000);
  assert.ok(after.underwriting.result!.profitBase! > before.underwriting.result!.profitBase!);
  assert.ok(after.underwriting.result!.roiBase! > before.underwriting.result!.roiBase!);
  assert.deepEqual(after.market.result, before.market.result);
  assert.equal(merged.negotiatedPrice.actorId, actor);
  assert.equal(after.ceo.result?.criticalGates.find((g) => g.fact === "legalStatus")?.passed, false);
  assert.notEqual(after.ceo.result?.action, "KUP");
});
test("100k renovation total reuses underwriting and lowers profit and Max Buy", () => {
  const { before, after } = apply([answer("renovationBudget", 100000)], lodzDeal("UNCLEAR_RENOVATION"));
  assert.equal(after.underwriting.result?.renovationTotal, 100000);
  assert.ok(after.underwriting.result!.profitBase! < before.underwriting.result!.profitBase!);
  assert.ok(after.underwriting.result!.maxPurchasePrice! < before.underwriting.result!.maxPurchasePrice!);
  assert.equal(after.market, before.market);
});
test("legal document reference remains NEEDS_EVIDENCE, never auto verified or BUY", () => {
  const { after, merged } = apply([{ ...answer("legalStatus", "Sprzedający mówi, że KW jest czysta"), basis: "DOCUMENT_REFERENCE", evidenceUrl: "https://example.test/document" }]);
  assert.equal(merged.legalStatus.status, "NEEDS_EVIDENCE");
  assert.deepEqual(merged.legalStatus.transitions, ["OPEN", "ANSWERED", "NEEDS_EVIDENCE"]);
  assert.notEqual(after.ceo.result?.action, "KUP");
});
test("three Łódź synthetic cases retain missing legal gate and material conflicts", () => {
  for (const name of ["MISSING_KW", "UNCLEAR_RENOVATION", "EXPENSIVE_AREA_CONFLICT"] as const) {
    const deal = buildCanonicalDeal(lodzDeal(name));
    assert.notEqual(deal.ceo.result?.action, "KUP");
    if (name === "EXPENSIVE_AREA_CONFLICT") assert.equal(deal.verify.status, "BLOCKED");
  }
});
test("withdrawal restores baseline without dropping other answers; source change reopens resolved question", () => {
  const { before, merged } = apply([answer("negotiatedPrice", 260000), answer("renovationBudget", 100000)]);
  const room = { ...state(), answers: merged };
  assert.ok(!roomQuestions(before, room).some((q) => q.field === "negotiatedPrice"));
  const newSource = buildCanonicalDeal({ ...lodzDeal(), listing: { ...lodzDeal().listing, askingPrice: 310000 } });
  assert.ok(roomQuestions(newSource, room).some((q) => q.field === "negotiatedPrice"));
  assert.equal(answerOverrides(newSource, {}, merged).negotiatedPrice, undefined);
  const withdrawn = mergeAnswers(before, room, { requestId, expectedVersion: 1, answers: [{ ...answer("negotiatedPrice", 1), kind: "WITHDRAW", value: null }] }, actor, lodzDeal().now);
  const overrides = answerOverrides(before, room.baselineOverrides, withdrawn);
  assert.equal(overrides.negotiatedPrice, undefined);
  assert.ok(overrides.renovationPerM2);
  assert.equal(overrides.holdingMonths, 5);
});
test("nonfinancial legal note leaves financial tracks and timestamps unchanged", () => {
  const { before, after } = apply([answer("legalStatus", "Sprawdzę z prawnikiem")], { ...lodzDeal(), overrides: { holdingMonths: 5 } });
  assert.equal(before.underwriting, after.underwriting);
  assert.equal(before.market, after.market);
  assert.ok(!affectedDirectors(["legalStatus"]).includes("MARKET"));
});
test("invalid, duplicate, injected and secret-bearing answers are rejected", () => {
  assert.throws(() => parseAnswerCommand({ requestId: "-".repeat(36), expectedVersion: 1, answers: [answer("negotiatedPrice", 260000)] }));
  for (const answers of [[answer("askingPrice", -1)], [answer("askingPrice", NaN)], [answer("ownership", "Bearer secret")], [answer("ownerId", "another-user")], [answer("__proto__", 1)], [answer("constructor", 1)], [answer("askingPrice", 1), answer("askingPrice", 2)], [{ ...answer("legalStatus", "doc"), evidenceUrl: "https://example.test/doc?token=abc" }]]) assert.throws(() => parseAnswerCommand({ requestId, expectedVersion: 1, answers }));
});

test("a correction contradicting the advertised source price remains a material conflict", () => {
  const { after } = apply([answer("askingPrice", 260000)]);
  assert.equal(after.verify.status, "BLOCKED");
  assert.equal(after.underwriting.result, null);
  assert.notEqual(after.ceo.result?.action, "KUP");
});
test("preservation never hides changed provenance with unchanged numeric inputs", () => {
  const base = buildCanonicalDeal(lodzDeal());
  const changed = structuredClone(base);
  changed.market.provenance = [...changed.market.provenance, { field: "marketEvidence", provenance: "USER_ASSUMPTION", observedAt: "2026-10-16T00:00:00Z" }];
  assert.notEqual(preserveUnchangedDirectors(base, changed).market, base.market);
});

test("reanalysis preserves independent document evidence without promoting legal gates", () => {
  const before = buildCanonicalDeal(lodzDeal());
  const document = { ...before.evidenceFabric[0], id: "independent-document", documentId: "66666666-6666-4666-8666-666666666666", evidenceType: "DOCUMENT_OBSERVATION" as const, sourceName: "SYNTHETIC_DOCUMENT", verificationStatus: "UNVERIFIED" as const };
  before.evidenceFabric.push(document);
  const after = preserveUnchangedDirectors(before, buildCanonicalDeal({ ...lodzDeal(), overrides: { negotiatedPrice: 260000 } }));
  assert.deepEqual(after.evidenceFabric.find((item) => item.id === document.id), document);
  assert.equal(after.evidenceFabric.filter((item) => item.id === document.id).length, 1);
  assert.notEqual(after.ceo.result?.action, "KUP");
});
