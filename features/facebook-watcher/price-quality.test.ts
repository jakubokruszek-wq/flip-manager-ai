import assert from "node:assert/strict";
import test from "node:test";
import { extractFacebookProperty, resolveFacebookPrice } from "./extract-facebook-property.ts";
import { assessFacebookListingQuality, assessFacebookPriceQuality, facebookPriceReviewExplanation, isFacebookPriceSuspect, PRICE_SUSPECT_SCORE_CAP } from "./price-quality.ts";

// --- A. Sale price + rent in the same post -----------------------------------
test("A: sale price and rent in the same post never merge into one amount", async () => {
  const text = "Sprzedam mieszkanie 48 m², cena 399 000 zł. Czynsz 666 zł.";
  const value = await extractFacebookProperty({ postText: text });
  assert.equal(value.price, 399_000);
  assert.equal(value.sourceFacts?.administrativeRent, 666); // correctly captured as rent, kept separate from price
  const quality = assessFacebookPriceQuality({ price: value.price, area: value.area, sourceFacts: value.sourceFacts, listingIntent: value.listingIntent, priceProvenance: value.priceProvenance, postText: text });
  assert.equal(quality.status, "VERIFIED");
  assert.equal(quality.category, "SALE_PRICE");
});

// --- B. Only a fee is mentioned, no sale price --------------------------------
test("B: rent-only post never fabricates a sale price", async () => {
  const value = await extractFacebookProperty({ postText: "Do wynajęcia, czynsz 1666 zł miesięcznie." });
  assert.equal(value.price, null);
  const quality = assessFacebookPriceQuality({ price: value.price, area: value.area, postText: "czynsz 1666 zł" });
  assert.equal(quality.status, "MISSING");
});

// --- C. Price per m2 is never mistaken for a total ---------------------------
test("C: a lone price-per-m2 is not treated as a total asking price without area", () => {
  const resolved = resolveFacebookPrice("10 500 zł/m2", null);
  assert.equal(resolved.price, null);
  assert.equal(resolved.pricePerM2, 10_500);
});

// --- D/E. Thousands notation ---------------------------------------------------
test("D: '399 tys.' parses to 399000", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie 399 tys." })).price, 399_000);
});
test("E: '399k' colloquial shorthand resolves to 399000", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Cena 399k, 45 m2" })).price, 399_000);
});
test("'300k' and '300 K' both resolve to 300000, but 'km' is never mistaken for the k-shorthand", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie za 300k, 45 m2" })).price, 300_000);
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie za 300 K, 45 m2" })).price, 300_000);
  assert.equal((await extractFacebookProperty({ postText: "Odległość do centrum 300km, 45 m2" })).price, null);
});

// --- Dot-as-thousands-separator regression (the real production root cause found
// via the read-only existing-data audit: "Cena: 665.500 PLN" was parsed as 665.5) ---
test("ROOT CAUSE FIX: dot-grouped thousands after 'Cena:' are not misread as a decimal fraction", async () => {
  const real = await extractFacebookProperty({ postText: "Sprzedam mieszkanie 57,41 m2. Cena: 665.500 PLN" });
  assert.equal(real.price, 665_500);
  assert.notEqual(real.price, 665.5);
});
test("D2 (mission format list): '399.000' after 'Cena' resolves to 399000, not 399", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie. Cena: 399.000 zł" })).price, 399_000);
});
test("Polish number formats: space, dot-thousands and decimal-comma cents are all handled safely", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Cena: 299 999 zł" })).price, 299_999);
  assert.equal((await extractFacebookProperty({ postText: "Cena: 299.999 zł" })).price, 299_999);
  // A genuine decimal (grosze) after a comma must still work once grouped-thousands are present.
  assert.equal((await extractFacebookProperty({ postText: "Kwota do negocjacji: 299 999,50" })).price, 299_999.5);
});

// --- F. Text price vs OCR/image price conflict --------------------------------
test("F: a text price and a materially different vision price are flagged as a conflict, not silently resolved", () => {
  const quality = assessFacebookPriceQuality({ price: 399_000, area: 48, postText: "cena 399 000 zł", visionPrice: 389_000 });
  assert.equal(quality.conflict, true);
  assert.equal(quality.status, "SUSPECT");
  assert.ok(quality.reasonCodes.includes("PRICE_CONFLICT_TEXT_VS_IMAGE"));
  assert.equal(quality.candidates.length, 2);
});
test("F2: a text price and a near-identical vision price (rounding) is not a conflict", () => {
  const quality = assessFacebookPriceQuality({ price: 399_000, area: 48, postText: "cena 399 000 zł", visionPrice: 399_000 });
  assert.equal(quality.conflict, false);
});

// --- G. Multiple competing amounts in one post --------------------------------
test("G: an unlabelled post with several ambiguous numbers never guesses a price", () => {
  const text = "3 pokoje, 2 klimatyzacje, piętro 4, kontakt 881 291 778";
  assert.deepEqual(resolveFacebookPrice(text, null), { price: null, pricePerM2: null, source: "NONE" });
});

// --- H. No price at all --------------------------------------------------------
test("H: missing price yields status MISSING and category UNKNOWN_AMOUNT", () => {
  const quality = assessFacebookPriceQuality({ price: null, area: 45 });
  assert.equal(quality.status, "MISSING");
  assert.equal(quality.category, "UNKNOWN_AMOUNT");
  assert.equal(isFacebookPriceSuspect(quality.status), true);
});

// --- I. The absurd 666 zł case: traced root causes -----------------------------
test("I1 (root cause: manual override bypassing extraction): a raw 666 override is caught by the plausibility floor, not deleted", () => {
  const quality = assessFacebookPriceQuality({ price: 666, area: 45, postText: "cena 666 zł" });
  assert.equal(quality.status, "SUSPECT");
  assert.ok(quality.reasonCodes.includes("PRICE_BELOW_PLAUSIBLE_FLOOR"));
  assert.equal(quality.candidates[0]?.value, 666); // data is preserved, never discarded
});
test("I2 (root cause: RENT_OFFER intent sharing the sale-price field): a rental post's fee is categorized as RENT and marked suspect", () => {
  const quality = assessFacebookPriceQuality({ price: 1666, area: null, listingIntent: "RENT_OFFER" });
  assert.equal(quality.status, "SUSPECT");
  assert.equal(quality.category, "RENT");
  assert.ok(quality.reasonCodes.includes("PRICE_LOOKS_LIKE_RENT_INTENT"));
});
test("I3 (root cause: a sale price equal to the already-known administrative rent): flagged as CZYNSZ, not a sale price", () => {
  const quality = assessFacebookPriceQuality({ price: 700, area: 50, sourceFacts: { administrativeRent: 700, basement: null, dryingRoom: null, refreshedAt: null, bathroomRenovated: null, buildingRenovation: [], furnishingIncluded: null, additionalEquipmentPrice: null } });
  assert.equal(quality.status, "SUSPECT");
  assert.equal(quality.category, "CZYNSZ");
  assert.ok(quality.reasonCodes.includes("PRICE_MATCHES_ADMIN_RENT"));
});
test("I4: an implausible price/m2 (price present, area present, ratio absurd) is flagged even when the raw price alone looks plausible", () => {
  const quality = assessFacebookPriceQuality({ price: 12_000, area: 45 }); // ~267 PLN/m2
  assert.equal(quality.status, "SUSPECT");
  assert.ok(quality.reasonCodes.includes("PRICE_PER_M2_IMPLAUSIBLE"));
});

// --- J. A realistic but low price must not be deleted, only flagged confidence/status ---
test("J: a genuinely low but plausible price (e.g. a small studio) is not forced into SUSPECT by the absolute floor alone", () => {
  const quality = assessFacebookPriceQuality({ price: 120_000, area: 20, postText: "cena 120 000 zł" }); // 6000 PLN/m2, plausible
  assert.equal(quality.status, "VERIFIED");
  assert.equal(isFacebookPriceSuspect(quality.status), false);
});

// --- Listing quality gate --------------------------------------------------------
test("listing quality gate: COMPLETE requires a usable price, area, location and source together", () => {
  const verified = assessFacebookPriceQuality({ price: 399_000, area: 48, postText: "cena 399 000 zł" });
  const complete = assessFacebookListingQuality({ priceQuality: verified, area: 48, city: "Łódź", district: "Bałuty", street: "Testowa 1", originalUrl: "https://facebook.com/x" });
  assert.equal(complete.listingQuality, "COMPLETE");

  const suspect = assessFacebookPriceQuality({ price: 666, area: 48 });
  const usable = assessFacebookListingQuality({ priceQuality: suspect, area: 48, city: "Łódź", district: null, street: null, originalUrl: "https://facebook.com/x" });
  assert.equal(usable.listingQuality, "USABLE");

  const missing = assessFacebookPriceQuality({ price: null, area: null });
  const invalid = assessFacebookListingQuality({ priceQuality: missing, area: null, city: null, district: null, street: null, originalUrl: null });
  assert.equal(invalid.listingQuality, "INVALID");
});

// --- UI explanation copy ----------------------------------------------------------
test("UI copy names the suspected real category without asserting a legal defect", () => {
  const quality = assessFacebookPriceQuality({ price: 666, area: 45 });
  const explanation = facebookPriceReviewExplanation(quality, 666);
  assert.match(explanation ?? "", /666 zł/);
  assert.match(explanation ?? "", /inna kwota|opłata|czynsz|rata/);
});
test("UI copy for a missing price never invents a number", () => {
  const quality = assessFacebookPriceQuality({ price: null, area: null });
  assert.equal(facebookPriceReviewExplanation(quality, null), "Nie wykryto ceny sprzedaży w tym ogłoszeniu.");
});

// --- Explicit regression: the exact scenario from the mission -------------------
test("REGRESSION: 'Sprzedam mieszkanie 48 m², cena 399 000 zł. Czynsz administracyjny 666 zł.' resolves askingPrice=399000, never 666", async () => {
  const text = "Sprzedam mieszkanie 48 m², cena 399 000 zł. Czynsz administracyjny 666 zł.";
  const value = await extractFacebookProperty({ postText: text });
  assert.equal(value.price, 399_000);
  assert.notEqual(value.price, 666);
});

// --- Ranking safety: score cap for suspect/missing prices -----------------------
test("PRICE_SUSPECT_SCORE_CAP keeps a suspect-priced listing out of high-score territory", () => {
  assert.ok(PRICE_SUSPECT_SCORE_CAP < 60); // below the "Okazja"/opportunity threshold used elsewhere in the app
});

// --- Rata / zaliczka context words now guarded ----------------------------------
test("rata (installment) near a 4+ digit amount is excluded from the sale-price candidates", () => {
  const text = "Sprzedam mieszkanie, cena 450 000 zł. Rata kredytu 2500 zł miesięcznie.";
  const resolved = resolveFacebookPrice(text, null);
  assert.equal(resolved.price, 450_000);
});
test("zaliczka (deposit/advance) near a 4+ digit amount is excluded from the sale-price candidates", () => {
  const text = "Sprzedam mieszkanie, cena 450 000 zł. Wymagana zaliczka 5000 zł.";
  const resolved = resolveFacebookPrice(text, null);
  assert.equal(resolved.price, 450_000);
});
