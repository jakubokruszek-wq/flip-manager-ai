import assert from "node:assert/strict";
import test from "node:test";
import { extractFacebookProperty } from "./extract-facebook-property.ts";
import { resolveFacebookListingIntent } from "./facebook-intent.ts";

test("classifies the real buy request without mapping its ranges as a sale", async () => {
  const text = "Kupię za gotówkę mieszkanie 1-2 pokoje (30-40m2) w Łodzi. Może być do remontu. Do 220 000 zł";
  const intent = resolveFacebookListingIntent(text, "SELL_PROPERTY", 0.8);
  assert.deepEqual({ intent: intent.intent, reason: intent.reasonCode }, { intent: "BUY_PROPERTY", reason: "FACEBOOK_BUY_REQUEST" });
  const extracted = await extractFacebookProperty({ postText: text, listingIntent: intent.intent, intentConfidence: intent.confidence, images: [] });
  assert.equal(extracted.listingIntent, "BUY_PROPERTY");
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
