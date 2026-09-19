import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(process.cwd(), "features/investment-os/server/deal-service.ts"), "utf8");

test("Facebook listings never use the raw description as their normalized condition fact", () => {
  assert.doesNotMatch(source, /condition: text\(row\.description\)/, "condition must never equal the whole description");
  assert.match(source, /readFacebookCondition/, "Facebook listings must resolve condition through a dedicated normalizer");
  assert.match(source, /classifyFacebookConditionFromText/, "the deterministic fallback must reuse the existing extraction classifier, not invent a new one");
  assert.match(source, /listing_source_metadata/, "the preferred source is the already-stored normalized Facebook metadata");
});

test("Deal initialization reads the canonical normalized condition for Facebook and preserves prior behavior for other sources", () => {
  const toListingInput = source.match(/function toListingInput\([\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(toListingInput, /source === "facebook" \? facebookCondition : text\(row\.description\)/);
});
