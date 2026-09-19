import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const source = fs.readFileSync(path.join(process.cwd(), "features/facebook-watcher/server.ts"), "utf8");

test("both manual and automated Facebook import paths persist price_per_sqm through the single authoritative resolver", () => {
  const occurrences = source.match(/resolveFacebookPricePerSqm\((?:extracted|effective)\)/g) ?? [];
  assert.equal(occurrences.length, 2, "manual and automated import must both derive price_per_sqm the same way, so an explicit unit price is never lost when total price/area are absent");
  assert.doesNotMatch(source, /\.price\s*&&\s*\w+\.area\s*\?\s*\w+\.price\s*\/\s*\w+\.area\s*:\s*null/, "must not reintroduce a second, competing price/area-only unit-price calculation");
});
