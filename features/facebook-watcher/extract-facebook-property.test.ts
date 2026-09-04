import assert from "node:assert/strict";
import test from "node:test";
import { extractFacebookProperty, resolveFacebookPrice } from "./extract-facebook-property.ts";

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
    assert.equal((await extractFacebookProperty({ postText })).rooms, expectedRooms, postText);
  }
  assert.equal((await extractFacebookProperty({ postText: "Możliwość 3 pokoi, obecnie 2 pokoje" })).rooms, 2);
});

test("salon plus bedrooms does not invent a room count", async () => {
  // The existing parser does not model this phrasing; keep it fail-safe.
  assert.equal((await extractFacebookProperty({ postText: "Sprzedam mieszkanie: salon + 2 sypialnie" })).rooms, null);
});
