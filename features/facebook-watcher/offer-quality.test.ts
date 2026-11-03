import assert from "node:assert/strict";
import test from "node:test";
import {visibleFacebookSale} from "./offer-quality.ts";
test("require sale and one stored image; an image containing text is permitted",()=>{
  assert.equal(visibleFacebookSale("SELL_PROPERTY",["https://storage.test/text-poster.jpg"]),true);
  for(const photos of [[],null,[null],[""],["javascript:alert(1)"],["https://user:password@storage.test/a.jpg"]])assert.equal(visibleFacebookSale("SELL_PROPERTY",photos),false);
  for(const intent of [null,"UNKNOWN","BUY_PROPERTY","RENT_OFFER","RENT_WANTED","SERVICE","OTHER"])assert.equal(visibleFacebookSale(intent,["https://storage.test/a.jpg"]),false);
});
