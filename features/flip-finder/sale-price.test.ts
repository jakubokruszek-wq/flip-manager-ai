import assert from "node:assert/strict";
import test from "node:test";
import { invalidSalePriceWarning, isValidSalePrice, validSaleListings } from "./sale-price.ts";

test("sale price accepts only a finite positive total", () => {
  for (const value of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "150000"]) {
    assert.equal(isValidSalePrice(value), false, `${String(value)} must be rejected`);
  }
  assert.equal(isValidSalePrice(1), true);
  assert.equal(isValidSalePrice(160_000), true);
});

test("a bad non-Facebook row is skipped without affecting a valid row; missing Facebook price stays compatible", () => {
  const sourceRows = [
    { source: "olx", price: 0 },
    { source: "otodom", price: 439_000 },
    { source: "facebook", price: null },
  ];
  const result = validSaleListings(sourceRows as never);
  assert.deepEqual(result.listings, [sourceRows[1], sourceRows[2]]);
  assert.equal(result.skipped, 1);
  assert.equal(invalidSalePriceWarning(result.skipped), "INVALID_SALE_PRICE: pominięto 1 ofert bez poprawnej całkowitej ceny sprzedaży.");
});
