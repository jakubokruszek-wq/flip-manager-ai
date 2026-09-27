import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFacebookCollectorPayload } from "./facebook-normalization.ts";

const payload = (overrides: Record<string, unknown> = {}) => normalizeFacebookCollectorPayload({
  sourcePostUrl: "https://www.facebook.com/groups/lodz/posts/4486483384955652/?utm_source=feed&ref=share",
  title: "Mieszkanie 2 pokoje",
  groupName: "Łódź sprzedaż",
  authorName: "Sprzedający",
  content: "Pełny opis mieszkania, remont i balkon.",
  price: 280000,
  area: 59.9,
  rooms: 2,
  location: "Łódź, Bałuty",
  imageUrls: ["https://img.example/one.jpg"],
  ...overrides,
});

test("collector content identity is stable across tracking URL variants", () => {
  const first = payload();
  const second = payload({ sourcePostUrl: "https://m.facebook.com/groups/other/posts/4486483384955652?mibextid=abc" });
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.externalListingId, "facebook:post:4486483384955652");
  assert.equal(second.externalListingId, "facebook:post:4486483384955652");
});

test("collector identity changes when full content changes, even if price and area stay equal", () => {
  const first = payload();
  const second = payload({ content: "Inny opis, inna oferta, ta sama cena i metraż." });
  assert.notEqual(first.contentHash, second.contentHash);
});
