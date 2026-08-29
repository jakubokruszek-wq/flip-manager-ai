import assert from "node:assert/strict";
import test from "node:test";
import { resolveDeterministicFacebookSellFacts } from "./facebook-processing-policy.ts";

test("complete textual SELL can skip Vision", () => {
  assert.deepEqual(resolveDeterministicFacebookSellFacts("Sprzedam mieszkanie M3, 64 m2, 9200 z\u0142/m2"), {
    complete: true,
    price: 588800,
    pricePerM2: 9200,
    area: 64,
    rooms: 2,
  });
});

test("unresolved SELL still requires Vision", () => {
  assert.equal(resolveDeterministicFacebookSellFacts("Sprzedam mieszkanie w \u0141odzi").complete, false);
});

test("deterministic non-SELL never becomes a complete SELL", () => {
  assert.equal(resolveDeterministicFacebookSellFacts("Kupi\u0119 M3, 64 m2, bud\u017cet 588 800 z\u0142").complete, false);
  assert.equal(resolveDeterministicFacebookSellFacts("Wynajm\u0119 2 pokoje, 45 m2, 2500 z\u0142").complete, false);
});
