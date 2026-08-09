import assert from "node:assert/strict";
import test from "node:test";

import { parsePropertyUpdate, propertyUpdateColumns } from "./property-update";

const valid = {
  title: "Mieszkanie testowe", address: "ul. Testowa 1", city: "Łódź", district: "Bałuty", price: "350000,50", area: "45,2", rooms: "2", floor: "floor_4", totalFloors: "8", status: "analysis", source: "olx", description: "Notatka", originalUrl: "https://example.com/listing", images: ["https://example.com/image.jpg"], renovationCost: "25000", expectedSalePrice: "450000", profit: "45000", roi: "12,5",
};

test("parses a valid property update and normalizes external values", () => {
  const values = parsePropertyUpdate(valid);
  assert.deepEqual(propertyUpdateColumns(values), {
    title: "Mieszkanie testowe", address: "ul. Testowa 1", city: "Łódź", district: "Bałuty", price: 350000.5, area: 45.2, rooms: 2, floor: 4, total_floors: 8, status: "analysis", source: "olx", notes: "Notatka", original_url: "https://example.com/listing", images: ["https://example.com/image.jpg"], renovation_cost: 25000, expected_sale_price: 450000, profit: 45000, roi: 12.5,
  });
});

test("rejects an invalid price", () => {
  assert.throws(() => parsePropertyUpdate({ ...valid, price: "nie liczba" }), /Cena ma nieprawidłową wartość/);
});

test("normalizes ground floor and rejects an invalid floor", () => {
  assert.equal(parsePropertyUpdate({ ...valid, floor: "parter" }).floor, 0);
  assert.throws(() => parsePropertyUpdate({ ...valid, floor: "czwarte" }), /Piętro musi być liczbą/);
});

test("normalizes empty optional fields to null", () => {
  const values = parsePropertyUpdate({ ...valid, title: " ", city: "", district: "", price: "", floor: "", originalUrl: "", description: "", renovationCost: "", profit: "", roi: "", source: "" });
  assert.equal(values.title, null);
  assert.equal(values.city, null);
  assert.equal(values.price, null);
  assert.equal(values.floor, null);
  assert.equal(values.originalUrl, null);
  assert.equal(values.source, null);
});
