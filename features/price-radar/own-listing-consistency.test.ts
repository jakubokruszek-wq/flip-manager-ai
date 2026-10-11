import assert from "node:assert/strict";
import test from "node:test";
import { compareRadarIdentitySnapshots, findRadarOwnListingConflicts } from "./own-listing-consistency.ts";

test("small area rounding differences are tolerated and accessory spaces do not stand in for the dwelling area", () => {
  assert.deepEqual(findRadarOwnListingConflicts({
    area: 57, rooms: 3, floor: 6, locationText: "Bałuty-Doły, Zawiszy Czarnego",
    description: "Mieszkanie o powierzchni 57,5 m², z balkonem o powierzchni 6 m².",
  }), []);
  assert.deepEqual(findRadarOwnListingConflicts({
    area: 57, rooms: 3, floor: 6, locationText: "Bałuty-Doły, Zawiszy Czarnego",
    description: "Balkon ma 6 m². Metraż 58 m². Mieszkanie gotowe do zamieszkania.",
  }), [], "one-square-metre display rounding is accepted, including when the accessory area is mentioned first");
});

test("a direct statement about this apartment conflicts on area, rooms, floor, and specific location", () => {
  assert.deepEqual(findRadarOwnListingConflicts({
    area: 57, rooms: 3, floor: 6, locationText: "Łódź, Bałuty-Doły, Zawiszy Czarnego",
    description: "Na sprzedaż mieszkanie o powierzchni 45 m², 2 pokoje, położone na parterze na łódzkim Teofilowie.",
  }), ["area", "rooms", "floor", "location"]);
});

test("planned room layouts and claims about another dwelling do not create false contradictions", () => {
  assert.deepEqual(findRadarOwnListingConflicts({
    area: 57, rooms: 3, floor: 6, locationText: "Bałuty-Doły, Zawiszy Czarnego",
    description: "Mieszkanie o powierzchni 57 m². Planowany układ pozwala wydzielić czwarty pokój. Inne mieszkanie ma 2 pokoje i 45 m².",
  }), []);
});

test("an id reimport with changed property facts is flagged, but a price-only update is not an identity change", () => {
  const previous = { area: 45, rooms: 2, floor: 0, locationText: "Łódź, Teofilów, Łanowa", price: 419_000 };
  assert.deepEqual(compareRadarIdentitySnapshots(previous, { ...previous, price: 549_000 }), [], "a substantial price adjustment alone is not a new property identity");
  assert.deepEqual(compareRadarIdentitySnapshots(previous, { ...previous, area: 46 }), [], "a one-square-metre portal rounding change is not a different dwelling");
  assert.deepEqual(compareRadarIdentitySnapshots(previous, { area: 57, rooms: 3, floor: 6, locationText: "Łódź, Bałuty-Doły, Zawiszy Czarnego" }), ["area", "rooms", "floor", "location"]);
});

test("an explicit conflicting asking price for this apartment is quarantined, while rent, accessories, other units, and ordinary reprice are not", () => {
  const facts = { area: 45, rooms: 2, floor: 0, price: 432_000, locationText: "Łódź, Teofilów, Plantowa" };
  assert.deepEqual(findRadarOwnListingConflicts({ ...facts, description: "Cena mieszkania: 419 000 zł. Lokal jest po remoncie." }), ["price"]);
  assert.deepEqual(findRadarOwnListingConflicts({ ...facts, description: "Cena całkowita mieszkania wynosi 432 000 PLN." }), []);
  assert.deepEqual(findRadarOwnListingConflicts({ ...facts, description: "Czynsz najmu 2 100 zł miesięcznie. Cena za miejsce postojowe 45 000 zł." }), []);
  assert.deepEqual(findRadarOwnListingConflicts({ ...facts, description: "Inne mieszkanie ma cenę 419 000 zł. To mieszkanie ma 45 m²." }), []);
  assert.deepEqual(compareRadarIdentitySnapshots({ ...facts, price: 419_000 }, facts), [], "price-only changes across reimports are not an identity mismatch");
});
