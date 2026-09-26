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

// HOLD-blocker regression: "zł/mies." is a generic monthly-price-unit marker,
// not rental-specific vocabulary — real sale listings routinely state their
// administrative/HOA fee this exact way. An independent read-only review of
// da7a787 proved this text was misclassified RENT_OFFER before the fix
// (rentOfferSignal's "zl/mies" branch fired unconditionally, ahead of the
// explicit "sprzedam" sell signal). An explicit sale signal must always win
// over this weak running-cost phrasing, while genuine, unambiguous rental
// vocabulary (do wynajęcia, na wynajem, czynsz najmu, odstępne) must keep
// working exactly as before.
test("an explicit sale signal overrides the weak 'zł/mies.' running-cost signal — 'Sprzedam mieszkanie 50m2, czynsz administracyjny 500 zł/mies.'", () => {
  const result = resolveFacebookListingIntent("Sprzedam mieszkanie 50m2, czynsz administracyjny 500 zł/mies.", null, null);
  assert.equal(result.intent, "SELL_PROPERTY");
  assert.equal(result.reasonCode, null, "a genuine sale must never carry a skip reason");
});

test("other explicit sale signals (na sprzedaż, cena sprzedaży) also override the weak 'zł/mies.' signal", () => {
  assert.equal(resolveFacebookListingIntent("Mieszkanie na sprzedaż, opłaty czynszowe 450 zł/mies.", null, null).intent, "SELL_PROPERTY");
  assert.equal(resolveFacebookListingIntent("Sprzedam mieszkanie, cena sprzedaży 450000 zł, czynsz 500 zł/mies.", null, null).intent, "SELL_PROPERTY");
});

test("a genuine minimalist rental ad using only 'zł/mies.' (no explicit sale signal) is still RENT_OFFER", () => {
  const result = resolveFacebookListingIntent("Kawalerka 30m2, 1500 zł/mies.", null, null);
  assert.equal(result.intent, "RENT_OFFER");
  assert.equal(result.reasonCode, "FACEBOOK_RENT_REQUEST");
});

test("strong rental phrases (do wynajęcia, na wynajem, czynsz najmu, odstępne) still win even though they are unaffected by the weak-signal change", () => {
  for (const text of [
    "Mieszkanie do wynajęcia, Łódź",
    "Mieszkanie na wynajem, Łódź, 2 pokoje",
    "Mieszkanie 45m2, czynsz najmu 2000 zł",
    "Mieszkanie z odstępnym, 2 pokoje",
  ]) {
    const result = resolveFacebookListingIntent(text, null, null);
    assert.equal(result.intent, "RENT_OFFER", `expected RENT_OFFER for: ${text}`);
  }
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

// HOLD-blocker: a text with BOTH an explicit sale keyword AND a strong,
// unambiguous rental keyword must never silently become RENT_OFFER
// (excluding it from sale sourcing) nor a clean, unflagged sale — it must
// stay SELL_PROPERTY (so importFacebookWatcher's SELL_PROPERTY-only gate
// still persists it) while being explainably flagged, the same way the
// existing BUY/SELL conflict already is.
test("a strong SELL + strong RENT conflict stays SELL_PROPERTY (never excluded), flagged with conflict=true", () => {
  const result = resolveFacebookListingIntent("Sprzedam mieszkanie, ale możliwe też do wynajęcia.", null, null);
  assert.equal(result.intent, "SELL_PROPERTY", "must never be excluded from sale sourcing");
  assert.equal(result.conflict, true, "the ambiguity must be explainable, not silently resolved");
  assert.equal(result.intentSource, "CONFLICT");
  assert.equal(result.reasonCode, null, "SELL_PROPERTY must never carry a skip reason");
});

test("other strong SELL + strong RENT phrasings are also flagged, never silently RENT_OFFER", () => {
  for (const text of [
    "Mieszkanie na sprzedaż lub do wynajęcia, do uzgodnienia.",
    "Sprzedam mieszkanie, czynsz najmu też możliwy do ustalenia.",
  ]) {
    const result = resolveFacebookListingIntent(text, null, null);
    assert.equal(result.intent, "SELL_PROPERTY", `expected SELL_PROPERTY for: ${text}`);
    assert.equal(result.conflict, true, `expected conflict=true for: ${text}`);
  }
});

// Preserve every already-fixed adjacent case: none of these have BOTH a
// strong sell AND a strong rent signal, so none should ever trip the new
// conflict path.
test("previously-fixed adjacent cases are unaffected by the new SELL/RENT conflict path", () => {
  const cases: Array<[string, "SELL_PROPERTY" | "RENT_OFFER"]> = [
    ["Na sprzedaż mieszkanie. Czynsz 615 zł.", "SELL_PROPERTY"],
    ["Sprzedam mieszkanie obecnie wynajęte za 2200 zł/mies.", "SELL_PROPERTY"],
    ["Mieszkanie inwestycyjne z najemcą płacącym 2000 zł/mies., cena sprzedaży 400 000 zł.", "SELL_PROPERTY"],
    ["Kawalerka 30m2, 1500 zł/mies.", "RENT_OFFER"],
    ["Mieszkanie do wynajęcia, Łódź", "RENT_OFFER"],
  ];
  for (const [text, expected] of cases) {
    const result = resolveFacebookListingIntent(text, null, null);
    assert.equal(result.intent, expected, `expected ${expected} for: ${text}`);
    assert.equal(result.conflict, false, `expected no conflict for: ${text}`);
  }
});

// A genuine BUY/SELL conflict must keep its own, pre-existing behavior
// (UNKNOWN, excluded) -- this mission only changes SELL/RENT conflicts.
test("a genuine BUY/SELL conflict is unaffected by the new SELL/RENT conflict path", () => {
  const result = resolveFacebookListingIntent("Kupię lub sprzedam mieszkanie w Łodzi.", null, null);
  assert.equal(result.intent, "UNKNOWN");
  assert.equal(result.conflict, true);
});

// Real production bug: a rental with no explicit sale keyword ("wolne od
// [data]" — the standard Polish "available from" rental phrasing — plus a
// plain price and area, no "sprzedam"/"na sprzedaż"/"cena sprzedaży" at all)
// was misread as a confident SELL_PROPERTY, because the weak, keyword-free
// SELL_STRUCTURED_OFFER heuristic (any property post with an area and a
// price number) was the only signal that fired. It must be RENT_OFFER (or
// excluded), never get a sale valuation.
test("a real 'wolne od' rental with no sale keyword is never read as a sale — the exact reported production case", () => {
  const result = resolveFacebookListingIntent(
    "Mieszkanie Łódź Górna wolne od 1 - 100/100 NISKI PRIORYTET 2000 zł 46 m2",
    null,
    null,
  );
  assert.equal(result.intent, "RENT_OFFER");
  assert.equal(result.reasonCode, "FACEBOOK_RENT_REQUEST");
});

test("'wolne od' rental phrasings without any sale keyword stay RENT_OFFER", () => {
  for (const text of [
    "Kawalerka, wolne od zaraz, 1800 zł, 28m2",
    "Mieszkanie 2 pokoje, wolne od 15.02, 2200 zł miesięcznie",
  ]) {
    const result = resolveFacebookListingIntent(text, null, null);
    assert.equal(result.intent, "RENT_OFFER", `expected RENT_OFFER for: ${text}`);
  }
});

test("bare 'wynajem'/'najem' labels without any sale keyword are never read as a sale", () => {
  for (const text of [
    "Wynajem: mieszkanie 2 pokoje, 46m2, 2000 zł",
    "Najem mieszkania, Łódź, 46m2, 2000 zł",
  ]) {
    const result = resolveFacebookListingIntent(text, null, null);
    assert.equal(result.intent, "RENT_OFFER", `expected RENT_OFFER for: ${text}`);
  }
});

// "wolne od" is ambiguous on its own (a sale listing may also note vacant
// possession, e.g. "wolne od zaraz" meaning immediate handover) — it must
// never override an explicit, unambiguous sale keyword.
test("an explicit sale keyword still wins over 'wolne od' vacant-possession phrasing", () => {
  const result = resolveFacebookListingIntent(
    "cena sprzedaży 369000 zł, mieszkanie 46m2, wolne od zaraz",
    null,
    null,
  );
  assert.equal(result.intent, "SELL_PROPERTY");
  assert.equal(result.intentSource, "DETERMINISTIC_SELL");
  assert.equal(result.conflict, false);
});
