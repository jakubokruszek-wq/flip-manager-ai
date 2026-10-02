import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyOtodomUrl,
  rejectionWarnings,
} from "./otodom-normalization.ts";

test("Otodom accepts desktop/mobile offer URLs with tracking and trailing slash", () => {
  assert.equal(classifyOtodomUrl("https://www.otodom.pl/pl/oferta/mieszkanie-IDABC123/?utm_source=feed"), null);
  assert.equal(classifyOtodomUrl("https://m.otodom.pl/pl/oferta/mieszkanie-IDabc123"), null);
  assert.equal(classifyOtodomUrl("/pl/oferta/mieszkanie-IDabc123.html?utm_source=feed"), null);
});

test("Otodom diagnostics distinguish malformed, search, placeholder, and missing-id URLs", () => {
  assert.equal(classifyOtodomUrl("not a url"), "invalid_url");
  assert.equal(classifyOtodomUrl("https://www.otodom.pl/pl/wyniki/sprzedaz/mieszkanie/lodz"), "search_or_category_url");
  assert.equal(classifyOtodomUrl("https://www.otodom.pl/[lang]/oferta/mieszkanie-IDABC123"), "placeholder_url");
  assert.equal(classifyOtodomUrl("https://www.otodom.pl/pl/oferta/mieszkanie-bez-id"), "missing_offer_id");
  assert.deepEqual(rejectionWarnings({ invalid_url: 2, missing_area: 1 }), [
    "Otodom: invalid_url (2)",
    "Otodom: missing_area (1)",
  ]);
});
