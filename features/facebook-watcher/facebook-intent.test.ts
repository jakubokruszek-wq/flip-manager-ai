import assert from "node:assert/strict";
import test from "node:test";
import { extractFacebookProperty } from "./extract-facebook-property.ts";
import { inspectFacebookIntentSignals, resolveFacebookListingIntent } from "./facebook-intent.ts";

test("classifies the real buy request without mapping its ranges as a sale", async () => {
  const text = "Kupię za gotówkę mieszkanie 1-2 pokoje (30-40m2) w Łodzi. Może być do remontu. Do 220 000 zł";
  const intent = resolveFacebookListingIntent(text, "SELL_PROPERTY", 0.98);
  assert.deepEqual(
    { intent: intent.intent, source: intent.intentSource, deterministic: intent.deterministicIntent, reason: intent.reasonCode },
    { intent: "BUY_PROPERTY", source: "DETERMINISTIC_BUY", deterministic: "BUY_PROPERTY", reason: "FACEBOOK_BUY_REQUEST" },
  );
  const extracted = await extractFacebookProperty({ postText: text, listingIntent: intent.intent, intentConfidence: intent.confidence, images: [] });
  assert.equal(extracted.listingIntent, "BUY_PROPERTY");
  assert.equal(extracted.intentSource, "DETERMINISTIC_BUY");
  assert.deepEqual({ price: extracted.price, area: extracted.area, rooms: extracted.rooms, condition: extracted.condition }, { price: null, area: null, rooms: null, condition: null });
});

test("classifies an explicit sale using the full property context", async () => {
  const text = "Sprzedam mieszkanie 42,4 m2, 2 pokoje, Łódź Retkinia, 339 000 zł";
  const intent = resolveFacebookListingIntent(text, "UNKNOWN", 0);
  assert.equal(intent.intent, "SELL_PROPERTY");
  const extracted = await extractFacebookProperty({ postText: text, listingIntent: intent.intent, intentConfidence: intent.confidence, images: [] });
  assert.equal(extracted.price, 339_000);
  assert.equal(extracted.area, 42.4);
  assert.equal(extracted.rooms, 2);
  assert.equal(extracted.city, "Łódź");
});

test("distinguishes rent wanted, rent offer, service and unknown posts", () => {
  assert.equal(resolveFacebookListingIntent("Szukam mieszkania do wynajęcia w Łodzi", null, null).intent, "RENT_WANTED");
  assert.equal(resolveFacebookListingIntent("Mieszkanie do wynajęcia w Łodzi", null, null).intent, "RENT_OFFER");
  assert.equal(resolveFacebookListingIntent("Oferuję usługi remontowe i wykończenia wnętrz", null, null).intent, "SERVICE");
  assert.equal(resolveFacebookListingIntent("Co słychać w Łodzi?", null, null).intent, "UNKNOWN");
});

// Rental-offer classification mission: additional rental signals
// (na wynajem, czynsz najmu, zł/mies., odstępne — every one unambiguous on
// its own) must all be recognized as RENT_OFFER and produce the same
// FACEBOOK_RENT_REQUEST skip reason as the pre-existing signals.
test("additional rental signals (na wynajem, czynsz najmu, zł/mies., odstępne) are all classified RENT_OFFER", () => {
  for (const text of [
    "Mieszkanie na wynajem, Łódź, 2 pokoje",
    "Mieszkanie 45m2, czynsz najmu 2000 zł",
    "Kawalerka 30m2, 1500 zł/mies.",
    "Mieszkanie z odstępnym, 2 pokoje",
  ]) {
    const result = resolveFacebookListingIntent(text, null, null);
    assert.equal(result.intent, "RENT_OFFER", `expected RENT_OFFER for: ${text}`);
    assert.equal(result.reasonCode, "FACEBOOK_RENT_REQUEST");
  }
});

// The exact mixed-text case from the mission: a sale listing that merely
// mentions the administrative "czynsz" (building maintenance fee, not
// rental rent) must never be misclassified as a rental offer just because
// the bare word "czynsz" appears somewhere in the text.
test("a sale listing mentioning administrative czynsz is SALE, never RENT — 'Na sprzedaż mieszkanie. Czynsz 615 zł.'", () => {
  const result = resolveFacebookListingIntent("Na sprzedaż mieszkanie. Czynsz 615 zł.", null, null);
  assert.equal(result.intent, "SELL_PROPERTY");
  assert.equal(result.reasonCode, null, "a genuine sale must never carry a skip reason");
});

test("a sale listing mentioning a monthly administrative fee (miesięcznie) is still SALE — the weak word alone must never flip the classification", () => {
  const result = resolveFacebookListingIntent("Mieszkanie na sprzedaż, czynsz administracyjny 450 zł miesięcznie", null, null);
  assert.equal(result.intent, "SELL_PROPERTY");
});

test("additional sale signals (cena sprzedaży, sprzedaż mieszkania) are recognized as SELL_PROPERTY", () => {
  assert.equal(resolveFacebookListingIntent("Sprzedam mieszkanie, cena sprzedaży 450000 zł", null, null).intent, "SELL_PROPERTY");
  assert.equal(resolveFacebookListingIntent("Sprzedaż mieszkania Łódź Widzew, 3 pokoje", null, null).intent, "SELL_PROPERTY");
});

test("deterministic sale overrides a conflicting Vision intent", () => {
  const result = resolveFacebookListingIntent("Sprzedam mieszkanie 42 m2, Łódź, 339 000 zł", "BUY_PROPERTY", 0.9);
  assert.deepEqual({ intent: result.intent, source: result.intentSource }, { intent: "SELL_PROPERTY", source: "DETERMINISTIC_SELL" });
});

test("Na sprzedaż authoritative text remains SELL despite weaker fallback", () => {
  const result = resolveFacebookListingIntent("Na sprzedaż mieszkanie, 25,6 m², 268 500 zł", "UNKNOWN", 0.2);
  assert.deepEqual({ intent: result.intent, source: result.intentSource }, { intent: "SELL_PROPERTY", source: "DETERMINISTIC_SELL" });
});

test("real buy and sell conflict is unknown and cannot persist", () => {
  const result = resolveFacebookListingIntent("Szukam mieszkania dla klienta, ale sprzedam też własne mieszkanie.", "SELL_PROPERTY", 0.99);
  assert.deepEqual({ intent: result.intent, source: result.intentSource, conflict: result.conflict }, { intent: "UNKNOWN", source: "CONFLICT", conflict: true });
});

test("Vision decides only when text has no strong deterministic signal", () => {
  const result = resolveFacebookListingIntent("Atrakcyjna propozycja w centrum Łodzi", "SELL_PROPERTY", 0.91);
  assert.deepEqual({ intent: result.intent, source: result.intentSource }, { intent: "SELL_PROPERTY", source: "VISION" });
});

test("detects BUY_KUPIE with Polish diacritics", () => {
  const signals = inspectFacebookIntentSignals("Kupię za gotówkę mieszkanie w Łodzi");
  assert.deepEqual(signals.buySignals, ["BUY_KUPIE"]);
  assert.deepEqual(signals.sellSignals, []);
});

test("detects BUY_KUPIE without Polish diacritics", () => {
  const signals = inspectFacebookIntentSignals("Kupie za gotowke mieszkanie w Lodzi");
  assert.deepEqual(signals.buySignals, ["BUY_KUPIE"]);
});

test("normalizes hidden Unicode and non-breaking spaces", () => {
  const signals = inspectFacebookIntentSignals("Ku\u200Bpię\u00a0za\u00a0gotówkę mieszkanie w Łodzi");
  assert.deepEqual(signals.buySignals, ["BUY_KUPIE"]);
});

test("known authoritative SELL variants remain deterministic", () => {
  for (const text of [
    "Na sprzedaż, dwa rozkładowe pokoje w Łodzi",
    "OFF MARKET mieszkanie 51 m² w Łodzi",
    "Mieszkanie przy Płockiej 4 w Łodzi, 80,53 m2 za 630 tys.",
  ]) {
    const result = resolveFacebookListingIntent(text, "UNKNOWN", 0);
    assert.deepEqual({ intent: result.intent, source: result.intentSource }, { intent: "SELL_PROPERTY", source: "DETERMINISTIC_SELL" });
  }
});
