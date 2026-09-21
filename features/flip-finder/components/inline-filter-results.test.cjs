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

// Hotfix D: a push/alert deep link for a non-Facebook (or Facebook) REVIEW
// listing used the same ?listing= contract as MATCHED, but ReviewListingCard
// never consumed deepLinkListingId at all — the parameter was silently
// ignored and the user landed on the page with nothing scrolled to or
// highlighted. This never moves a REVIEW listing into the MATCHED bucket or
// touches canonical semantics — it is a client-only scroll/highlight effect,
// exactly mirroring the existing autoOpen pattern used for MATCHED cards.
test("non-Facebook REVIEW: the exact deep-linked card scrolls into view and is highlighted, without changing its canonical bucket", () => {
  assert.match(page, /function ReviewListingCardContent\(\{ result, onChanged, highlight = false \}: \{ result: FilterResult; onChanged: \(\) => void; highlight\?: boolean \}\)/, "ReviewListingCardContent must accept an optional highlight prop, default false, so every existing call site keeps working unchanged");
  assert.match(page, /const articleRef = useRef<HTMLElement>\(null\);/, "a ref on the card's own root element is required to scroll it into view");
  assert.match(page, /if \(highlight && !highlightedRef\.current\) \{\s*highlightedRef\.current = true;\s*articleRef\.current\?\.scrollIntoView\(\{ behavior: "smooth", block: "center" \}\);/, "highlighting must scroll the exact card into view exactly once, never re-triggered by an unrelated rerender");
  assert.match(page, /<article className=\{`ui-card border-amber-400\/25 p-4 \$\{highlight \? "ring-2 ring-gold ring-offset-2 ring-offset-background" : ""\}`\} ref=\{articleRef\}>/, "the highlight must be a purely visual ring on the existing card styling, not a new component or layout");
  assert.match(page, /function ReviewListingCard\(\{ result, onChanged, highlight = false \}: \{ result: FilterResult; onChanged: \(\) => void; highlight\?: boolean \}\)/, "the outer ReviewListingCard wrapper must forward the same optional highlight prop");
  assert.match(page, /<ReviewListingCardContent highlight=\{highlight\} onChanged=\{onChanged\} result=\{result\} \/>/, "ReviewListingCard must actually pass highlight down to its content, not just accept and drop it");
  assert.match(page, /<ReviewListingCard highlight=\{result\.id === deepLinkListingId\} key=\{result\.id\} result=\{result\} onChanged=\{\(\) => void load\(\)\} \/>/, "the review results list must wire highlight to the exact same deepLinkListingId contract already used for MATCHED cards");
});

// Regression guard for the pre-existing MATCHED deep link (Task 3): must be
// byte-identical to before this hotfix — this patch only adds REVIEW support
// alongside it, never touches the MATCHED path.
test("non-Facebook MATCHED deep link has no regression: autoOpen is still wired to the same deepLinkListingId contract", () => {
  assert.match(page, /<ExpandableListingCard autoOpen=\{result\.id === deepLinkListingId\} averagePricePerSqm=\{data\?\.filter\.maxPricePerSqm \?\? null\} key=\{result\.id\} marketType=\{data\?\.filter\.marketType \?\? null\} onChanged=\{\(\) => void load\(\)\} result=\{result\} \/>/);
  assert.match(page, /const autoOpenedRef = useRef\(false\);/);
});
