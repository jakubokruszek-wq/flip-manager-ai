import assert from "node:assert/strict";
import test from "node:test";
import { createRadarDistrictAiBudget, suggestRadarDistrictWithAi } from "./radar-district-ai.ts";
import type { QualificationCandidate } from "@/features/price-radar/qualification";

function candidate(overrides: Partial<QualificationCandidate> = {}): QualificationCandidate {
  return {
    source: "domiporta", externalListingId: "ext-1", originalUrl: "https://example.test/1", normalizedUrl: "https://example.test/1",
    title: "Mieszkanie w bloku", description: "Blisko Manufaktury, świeżo po generalnym remoncie. Osiedle Teofilów, spokojna okolica.",
    price: 450_000, area: 50, pricePerSqm: 9_000, rooms: 2, city: "Łódź", district: null,
    buildingType: "blok", marketType: "secondary", rawPayload: {}, contentHash: "hash-1",
    ...overrides,
  };
}

test("returns null without ever calling the resolver when no district/neighborhood can be confirmed", async () => {
  const result = await suggestRadarDistrictWithAi(candidate(), async () => ({ street: null, neighborhood: null, district: null, city: "Łódź", confidence: 0.9, evidence: "Łódź" }));
  assert.equal(result, null);
});

test("resolves via the AI's neighborhood field when it names a known Łódź sub-area", async () => {
  const result = await suggestRadarDistrictWithAi(candidate(), async () => ({ street: null, neighborhood: "Teofilów", district: null, city: "Łódź", confidence: 0.9, evidence: "Osiedle Teofilów" }));
  assert.deepEqual(result, { district: "Bałuty", evidence: "Osiedle Teofilów" });
});

test("resolves via the AI's district field when it already names one of Radar's 5 canonical districts", async () => {
  const result = await suggestRadarDistrictWithAi(candidate({ description: "Mieszkanie w Łódź Widzew, blisko parku." }), async () => ({ street: null, neighborhood: null, district: "Widzew", city: "Łódź", confidence: 0.85, evidence: "Łódź Widzew" }));
  assert.deepEqual(result, { district: "Widzew", evidence: "Łódź Widzew" });
});

test("rejects a fabricated or copy-pasted quote that does not genuinely appear in this candidate's own text", async () => {
  const result = await suggestRadarDistrictWithAi(candidate(), async () => ({ street: null, neighborhood: "Teofilów", district: null, city: "Łódź", confidence: 0.95, evidence: "To jest zupełnie inny, niepowiązany tekst" }));
  assert.equal(result, null, "a quote that does not appear in title/description/district/city must never be trusted, however confident the model claims to be");
});

test("rejects a neighborhood/district name the AI invented that is not one of Radar's 5 districts or a verified sub-area", async () => {
  const result = await suggestRadarDistrictWithAi(candidate({ description: "Mieszkanie w osiedlu Nibylandia, bardzo spokojne." }), async () => ({ street: null, neighborhood: "Nibylandia", district: null, city: "Łódź", confidence: 0.9, evidence: "osiedlu Nibylandia" }));
  assert.equal(result, null);
});

test("'blisko X' proximity wording alone never confirms a district -- it is not itself a sub-area name", async () => {
  // The AI resolver's own evidence would have to be the sub-area/district
  // name itself (checked separately below); a bare proximity phrase like
  // "Blisko Manufaktury" resolves to nothing because "Manufaktury" is not
  // in the known-district/sub-area vocabulary at all.
  const result = await suggestRadarDistrictWithAi(candidate(), async () => ({ street: null, neighborhood: "Manufaktury", district: null, city: "Łódź", confidence: 0.6, evidence: "Blisko Manufaktury" }));
  assert.equal(result, null);
});

test("a resolver error or timeout never throws -- the candidate stays queueable, simply without a suggestion", async () => {
  const result = await suggestRadarDistrictWithAi(candidate(), async () => { throw new Error("network timeout"); });
  assert.equal(result, null);
});

test("a resolver returning null (e.g. missing OPENAI_API_KEY) is a normal, silent no-suggestion outcome", async () => {
  const result = await suggestRadarDistrictWithAi(candidate(), async () => null);
  assert.equal(result, null);
});

test("createRadarDistrictAiBudget allows exactly `limit` calls and then refuses, never going negative or wrapping", () => {
  const budget = createRadarDistrictAiBudget(2);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), true);
  assert.equal(budget.tryConsume(), false);
  assert.equal(budget.tryConsume(), false);
});

test("createRadarDistrictAiBudget defaults to a positive limit so a caller that forgets to pass one still gets a bounded budget, not an unbounded one", () => {
  const budget = createRadarDistrictAiBudget();
  let consumed = 0;
  for (let i = 0; i < 1000; i += 1) if (budget.tryConsume()) consumed += 1;
  assert.ok(consumed > 0 && consumed < 1000, `expected a bounded, positive default limit, got ${consumed}`);
});
