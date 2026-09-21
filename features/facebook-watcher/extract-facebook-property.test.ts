import assert from "node:assert/strict";
import test from "node:test";
import { classifyFacebookCondition, extractFacebookProperty, extractPolishStreet, resolveFacebookPrice, resolveFacebookPricePerSqm } from "./extract-facebook-property.ts";

test("Teofilów M3", async()=>{ const value=await extractFacebookProperty({postText:"Sprzedam M3 na Teofilowie 46m2 289 tys bez pośredników"}); assert.equal(value.neighborhood,"Teofilów"); assert.equal(value.district,"Bałuty"); assert.equal(value.area,46); assert.equal(value.rooms,2); assert.equal(value.price,289000); assert.equal(value.sellerType,"private"); });
test("Radogoszcz Zachód", async()=>{ const value=await extractFacebookProperty({postText:"Radogoszcz Zachód, 3 pokoje, 58 m2, do generalnego remontu"}); assert.equal(value.neighborhood,"Radogoszcz Zachód"); assert.equal(value.rooms,3); assert.equal(value.condition,"renovation"); });
test("brak ceny", async()=>assert.equal((await extractFacebookProperty({postText:"Mieszkanie na Teofilowie 46 m2"})).price,null));
test("brak lokalizacji", async()=>assert.equal((await extractFacebookProperty({postText:"Sprzedam 2 pokoje, 42 m2"})).city,null));
test("flagi nie zmieniają danych finansowych", async()=>{ const value=await extractFacebookProperty({postText:"Pilnie, okazja, prywatnie, 40 m2"}); assert.deepEqual(value.flags,["pilnie","okazja","prywatnie"]); assert.equal(value.price,null); });
test("dzielnica nie staje się osiedlem", async()=>{ const value=await extractFacebookProperty({postText:"Mieszkanie Bałuty, 45 m2"}); assert.equal(value.district,"Bałuty"); assert.equal(value.neighborhood,null); });

test("Retkinia price per m2 derives total and never reads the phone as price", async () => {
  const text = "Sprzedam 3 pokoje na Retkini‼️\n64 m2, widok na zieleń, dwie jednostki klimatyzacji\n9200 zł/m2\n881 291 778";
  const value = await extractFacebookProperty({ postText: text });
  const price = resolveFacebookPrice(text, value.area);
  assert.equal(value.area, 64);
  assert.equal(price.pricePerM2, 9200);
  assert.equal(value.price, 588800);
  assert.notEqual(value.price, 881291778);
});

test("spaced price per square metre derives the total", () => {
  const text = "Sprzedam mieszkanie, 64 m², 9 200 zł/m², tel. 881 291 778";
  assert.deepEqual(resolveFacebookPrice(text, 64), { price: 588800, pricePerM2: 9200, source: "DERIVED_FROM_PRICE_PER_M2" });
});

test("explicit total takes priority over derivation", () => {
  const text = "Cena 588 800 zł, 64 m2, 9 200 zł/m2";
  assert.deepEqual(resolveFacebookPrice(text, 64), { price: 588800, pricePerM2: 9200, source: "EXPLICIT_TOTAL" });
});

test("thousands notation is a total price", async () => {
  const value = await extractFacebookProperty({ postText: "Sprzedam mieszkanie 588 tys., 64 m2" });
  assert.equal(value.price, 588000);
});

test("phone without a price leaves price null", async () => {
  const value = await extractFacebookProperty({ postText: "Sprzedam mieszkanie 64 m2, tel. 881 291 778" });
  assert.equal(value.price, null);
});

test("unlabelled numbers and phone fragments are never guessed as price", () => {
  const text = "3 pokoje, 2 klimatyzacje, piętro 4, kontakt 881 291 778";
  assert.deepEqual(resolveFacebookPrice(text, null), { price: null, pricePerM2: null, source: "NONE" });
});
test("contextual amount without currency is accepted", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie. Kwota do negocjacji: 353000.00" })).price, 353000);
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie. Cena: 430000" })).price, 430000);
});
test("superscript square metre area is parsed safely", async () => {
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie, 47,22 m\u00b2" })).area, 47.22);
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie, 43.05 m2" })).area, 43.05);
});
test("Sporna listing keeps explicit fields and source facts without inventing floor or ownership", async()=>{
  const text = "Sprzedam mieszkanie przy ul. Sporna 72, Łódź. Cena 419 000 zł, 59,45 m2, 2 pokoje. Czynsz ok. 700 zł. Świeżo odświeżone w maju 2025. Łazienka po remoncie. Blok po remoncie dachu i elewacji. Suszarnia i własna piwnica. Opcjonalne wyposażenie ok. 20 000 zł.";
  const value = await extractFacebookProperty({ postText: text });
  assert.equal(value.price, 419_000);
  assert.equal(value.area, 59.45);
  assert.equal(value.rooms, 2);
  assert.equal(value.street, "Sporna 72");
  assert.equal(value.city, "Łódź");
  assert.equal(value.floor, null);
  assert.equal(value.sourceFacts?.administrativeRent, 700);
  assert.equal(value.sourceFacts?.basement, true);
  assert.equal(value.sourceFacts?.dryingRoom, true);
  assert.equal(value.sourceFacts?.bathroomRenovated, true);
  assert.deepEqual(value.sourceFacts?.buildingRenovation, ["roof", "facade"]);
  assert.equal(value.sourceFacts?.additionalEquipmentPrice, 20_000);
  assert.equal(value.description, text);
});

test("rooms, floor and condition require exact semantic evidence", async () => {
  const noRooms = await extractFacebookProperty({ postText: "Sprzedam mieszkanie 45 m2 w bloku z lat 80/90, po remoncie" });
  assert.deepEqual({ rooms: noRooms.rooms, floor: noRooms.floor, condition: noRooms.condition }, { rooms: null, floor: null, condition: "ready" });
  const exact = await extractFacebookProperty({ postText: "Sprzedam mieszkanie 2-pokojowe, 3. piętro, Łódź" });
  assert.deepEqual({ rooms: exact.rooms, floor: exact.floor }, { rooms: 2, floor: 3 });
});

// Polish phrasing states the floor both ways — "3. piętro" (number first, already
// covered above) and "piętro 3" (word first). Both orders must resolve to the
// same floor; only the word-first order was previously left unmatched.
test("floor is extracted regardless of word order: 'piętro N' resolves the same as 'N. piętro'", async () => {
  const wordFirst = await extractFacebookProperty({ postText: "Mieszkanie na sprzedaż, piętro 11, 47 m2" });
  assert.equal(wordFirst.floor, 11);
  const numberFirst = await extractFacebookProperty({ postText: "Mieszkanie na sprzedaż, 11 piętro, 47 m2" });
  assert.equal(numberFirst.floor, 11);
});

test("a floor/total-floors fraction is extracted in either word order", async () => {
  const wordFirst = await extractFacebookProperty({ postText: "Mieszkanie, piętro 4/10, 50 m2" });
  assert.deepEqual({ floor: wordFirst.floor, totalFloors: wordFirst.totalFloors }, { floor: 4, totalFloors: 10 });
  const numberFirst = await extractFacebookProperty({ postText: "Mieszkanie, 4/10 piętro, 50 m2" });
  assert.deepEqual({ floor: numberFirst.floor, totalFloors: numberFirst.totalFloors }, { floor: 4, totalFloors: 10 });
});

test("area token M2 is never converted into one room", async () => {
  const value = await extractFacebookProperty({ postText: "Sprzedam mieszkanie 30 M2 w Łodzi" });
  assert.equal(value.area, 30);
  assert.equal(value.rooms, null);
});

test("hashtags and conflicting M-layout labels never invent rooms", async () => {
  const value = await extractFacebookProperty({ postText: "Mieszkanie 80,53 m2 #M5 #M4 #apartament" });
  assert.equal(value.rooms, null);
});

test("current rooms win over possible rearrangement", async () => {
  const cases = [
    ["Sprzedam mieszkanie, 2 pokoje z możliwością 3", 2],
    ["Sprzedam mieszkanie, 2 pokoje, możliwość wydzielenia trzeciego", 2],
    ["Sprzedam mieszkanie, obecnie 2 pokoje, po zmianie układu 3", 2],
    ["Sprzedam mieszkanie, 3 pokoje", 3],
    ["Sprzedam mieszkanie 3-pokojowe", 3],
    ["Sprzedam mieszkanie, 2 pokoje + garderoba", 2],
  ] as const;
  for (const [postText, expectedRooms] of cases) {
    const value = await extractFacebookProperty({ postText });
    assert.equal(value.rooms, expectedRooms, postText);
    if (expectedRooms !== null) assert.equal(value.fieldConfidence?.rooms, 0.95, postText);
  }
  assert.equal((await extractFacebookProperty({ postText: "Możliwość 3 pokoi, obecnie 2 pokoje" })).rooms, 2);
});

test("salon plus bedrooms does not invent a room count", async () => {
  // The existing parser does not model this phrasing; keep it fail-safe.
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie: salon + 2 sypialnie" })).rooms, null);
});

test("explicit price-per-m2 survives extraction even without a total price or area", async () => {
  const text = "SPRZEDAM 5 500 zł/m2,\n2 pok. z możliw. 3,\nal. 1 Maja 20, blisko PŁ i UŁ, do remontu,\ninwestycyjne, tel.:737 338 309";
  const value = await extractFacebookProperty({ postText: text });
  assert.equal(value.price, null);
  assert.equal(value.area, null);
  assert.equal(value.pricePerM2, 5500);
  assert.equal(value.street, "al. 1 Maja 20");
  assert.equal(value.rooms, 2);
  assert.equal(value.condition, "renovation");
});

test("explicit price-per-m2 with a known area still derives the total (existing derivation semantics unchanged)", () => {
  const text = "Sprzedam mieszkanie, 5 500 zł/m2";
  assert.deepEqual(resolveFacebookPrice(text, 40), { price: 220_000, pricePerM2: 5500, source: "DERIVED_FROM_PRICE_PER_M2" });
});

test("resolveFacebookPricePerSqm: explicit unit price wins even when price/area are both present", () => {
  assert.equal(resolveFacebookPricePerSqm({ price: null, pricePerM2: 5500, area: null }), 5500);
  assert.equal(resolveFacebookPricePerSqm({ price: 220_000, pricePerM2: 5500, area: 40 }), 5500);
  assert.equal(resolveFacebookPricePerSqm({ price: 220_000, pricePerM2: null, area: 40 }), 5500);
  assert.equal(resolveFacebookPricePerSqm({ price: null, pricePerM2: null, area: 40 }), null);
  assert.equal(resolveFacebookPricePerSqm({ price: 220_000, pricePerM2: null, area: null }), null);
});

test("extractPolishStreet recognizes ul./ulica/al./aleja prefixes and never guesses city, room counts, prices or phone numbers", () => {
  assert.equal(extractPolishStreet("al. 1 Maja 20, blisko centrum"), "al. 1 Maja 20");
  assert.equal(extractPolishStreet("Aleja 1 Maja 20, blisko centrum"), "Aleja 1 Maja 20");
  assert.equal(extractPolishStreet("ul. Piotrkowska 100, Łódź"), "Piotrkowska 100");
  assert.equal(extractPolishStreet("ulica Piotrkowska 100, Łódź"), "Piotrkowska 100");
  assert.equal(extractPolishStreet("Sprzedam mieszkanie przy ul. Sporna 72, Łódź."), "Sporna 72");
  assert.equal(extractPolishStreet("Łódź"), null);
  assert.equal(extractPolishStreet("2 pokoje"), null);
  assert.equal(extractPolishStreet("5 500 zł/m2"), null);
  assert.equal(extractPolishStreet("tel. 737 338 309"), null);
});

test("classifyFacebookCondition: renovation and ready are distinguished, never invented without evidence", () => {
  const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pl-PL").replace(/ł/g, "l");
  assert.equal(classifyFacebookCondition(normalize("mieszkanie do remontu")), "renovation");
  assert.equal(classifyFacebookCondition(normalize("mieszkanie do generalnego remontu")), "renovation");
  assert.equal(classifyFacebookCondition(normalize("mieszkanie po remoncie")), "ready");
  assert.equal(classifyFacebookCondition(normalize("mieszkanie na sprzedaż, 2 pokoje")), null);
});

// Watcher data quality mission: real screenshot variants that previously
// failed to parse at all (price/area both null), proven one at a time
// against the unmodified parser before any regex change.
test("Watcher data quality: 'Metraż 53m Cena 489tyś' resolves both the bare-m area and the tyś-spelled price", async () => {
  const text = "Metraż 53m Cena 489tyś";
  const value = await extractFacebookProperty({ postText: text });
  assert.equal(value.area, 53);
  assert.equal(value.price, 489000);
  assert.equal(Math.round(resolveFacebookPricePerSqm({ price: value.price, pricePerM2: value.pricePerM2, area: value.area }) ?? 0), 9226);
});

test("Watcher data quality: 'Cena 489 tys' and 'Cena 489 tys.' both resolve to 489000 (already-working baseline, locked in)", () => {
  assert.equal(resolveFacebookPrice("Cena 489 tys", null).price, 489000);
  assert.equal(resolveFacebookPrice("Cena 489 tys.", null).price, 489000);
});

test("Watcher data quality: '489 000 zł' (space-grouped, already-working baseline) and '489.000 zł' (dot-grouped) both resolve to 489000", () => {
  assert.equal(resolveFacebookPrice("489 000 zł", null).price, 489000);
  assert.equal(resolveFacebookPrice("489.000 zł", null).price, 489000);
});

test("Watcher data quality: 'Cena sprzedaż 430.000zł' resolves to 430000, matching the mission's exact price/m² expectation", async () => {
  const text = "Cena sprzedaż 430.000zł, 52,97m2";
  const value = await extractFacebookProperty({ postText: text });
  assert.equal(value.price, 430000);
  assert.equal(value.area, 52.97);
  assert.equal(Math.round(resolveFacebookPricePerSqm({ price: value.price, pricePerM2: value.pricePerM2, area: value.area }) ?? 0), 8118);
});

test("Watcher data quality: '52,97m2' (comma-decimal area, already-working baseline) resolves to 52.97", async () => {
  const value = await extractFacebookProperty({ postText: "Mieszkanie na sprzedaż, 52,97m2" });
  assert.equal(value.area, 52.97);
});

test("Watcher data quality: a rent amount mentioned before the sale price is never mistaken for it, even across a sentence break", () => {
  const text = "Niski czynsz 615zł. Metraż 53m Cena 489tyś";
  const result = resolveFacebookPrice(text, 53);
  assert.equal(result.price, 489000);
  assert.notEqual(result.price, 615);
});

test("Watcher data quality: an auxiliary fee immediately next to its own number is still excluded — the sentence-break fix must not weaken this", () => {
  assert.equal(resolveFacebookPrice("Czynsz 1500zł. Cena 399000zł", null).price, 399000, "the real sale price after czynsz must still resolve");
  assert.equal(resolveFacebookPrice("Czynsz 1500zł, mieszkanie 48m2", null).price, null, "with no sale price anywhere in the text, 1500 (the fee) must never be guessed as one");
});

test("Watcher data quality: bare 'Xm' is only recognized as area right after an explicit metraż/powierzchnia keyword, never as a stray distance", async () => {
  assert.equal((await extractFacebookProperty({ postText: "5m od szkoły, mieszkanie na sprzedaż" })).area, null, "a bare distance mention must never be read as area");
  assert.equal((await extractFacebookProperty({ postText: "Powierzchnia 61m, blisko centrum" })).area, 61, "'Powierzchnia' is an equally valid area keyword to 'Metraż'");
});
