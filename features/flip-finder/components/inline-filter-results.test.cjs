/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "inline-filter-results.tsx"), "utf8");

// Task 4: price/m² must be one of the first values visible, using the
// existing Premium V3 gold accent — not a new color, not a redesign.
test("price per m² is styled with the existing Premium V3 gold accent, directly under the price", () => {
  assert.match(page, /text-2xl font-bold[^"]*"[^>]*>\{currency\(result\.price\)\}/, "the price itself must render first");
  assert.match(page, /text-gold">\{currencyPerSqm\(result\.pricePerSqm\)\}/, "price per m² must use the gold accent color");
});

test("currency/currencyPerSqm formatting is unchanged: Polish locale, PLN currency, no decimals", () => {
  assert.match(page, /new Intl\.NumberFormat\("pl-PL", \{ style: "currency", currency: "PLN", maximumFractionDigits: 0 \}\)/);
  assert.match(page, /function currencyPerSqm\(value: number \| null\): string \{ const formatted = currency\(value\); return formatted === "—" \? formatted : `\$\{formatted\}\/m²`; \}/);
});
