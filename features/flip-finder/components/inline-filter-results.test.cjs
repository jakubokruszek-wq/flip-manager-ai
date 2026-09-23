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

// Watcher data quality mission: the top card (ExpandableListingCardContent's
// own <article>) and the bottom status/action panel (GalleryRequestButton)
// were two visually separate blocks — the wrapper between them was
// display:contents, which cannot paint a border at all. Verified in a real
// browser (Playwright, computed styles): the wrapper's border-color resolves
// to the --gold token at 20% alpha and the article's own border resolves to
// fully transparent, so exactly one hairline border is ever visible around
// the whole offer, never two.
//
// Fix Actual Facebook Watcher Card UI mission: the /facebook-watcher page's
// own InboxItem <article> now owns the single outer border for the whole
// listing (status/action panel + this card together — see
// facebook-watcher-panel.test.cjs). This wrapper's border must therefore be
// suppressed for variant="watcher", or the Watcher would show two nested
// gold rectangles again; the default/"standalone" Finder usage is unchanged.
test("ExpandableListingCard draws exactly one thin gold border around the whole offer, never two — suppressed only when the Watcher's own <article> already owns it", () => {
  const start = page.indexOf("export function ExpandableListingCard(");
  assert.ok(start >= 0, "ExpandableListingCard must exist");
  const source = page.slice(start, page.indexOf("\n}\n", start));
  assert.match(source, /const wrapperBorderClassName = props\.variant === "watcher" \? "" : "overflow-hidden rounded-\[1\.125rem\] !border-2 !border-gold\/55 transition-colors duration-300 focus-within:!border-gold\/80 hover:!border-gold\/80";/, "the border must be computed from variant, empty only for \"watcher\", so the standalone Finder usage keeps its own single, stronger (2px, 55%->80%) border");
  assert.match(source, /return <div className=\{wrapperBorderClassName\} onClickCapture=\{handleCardClickCapture\} onPointerDownCapture=\{handleCardPointerCapture\}/, "the wrapper (top card + bottom panel) must carry the computed border class, not display:contents");
  // ReviewListingCard (a separate, untouched component) legitimately keeps
  // its own identically-named display:contents wrapper — this check is
  // scoped to ExpandableListingCard's own source only, not the whole file.
  assert.doesNotMatch(source, /<div className="contents" onClickCapture=\{handleCardClickCapture\}/, "the old display:contents wrapper (which cannot paint a border) must be gone from ExpandableListingCard specifically");
  assert.match(page, /<article className="ui-card ui-card-hover group overflow-hidden !border-transparent hover:!border-transparent">/, "the inner article's own border must be suppressed so it never doubles the outer one");
});

// The dialog header's score-badge + "Otwórz Deal Room" action row forced
// sm:flex-nowrap, which could overflow horizontally at ordinary (not
// ultra-wide) desktop widths instead of wrapping. flex-wrap only activates
// when content does not fit, so removing the forced nowrap is safe at every
// width — verified in a real browser (Playwright): the opened dialog has
// zero horizontal overflow (scrollWidth === clientWidth) at a 1280px viewport.
test("the dialog header's action row can wrap instead of forcing a horizontal scrollbar at desktop width", () => {
  assert.match(page, /<div className="flex w-full min-w-0 flex-wrap items-center gap-3 sm:w-auto">/, "the action row must allow wrapping at every breakpoint, not force sm:flex-nowrap");
  assert.doesNotMatch(page, /flex-wrap items-center gap-3 sm:w-auto sm:flex-nowrap/, "the forced no-wrap that caused the overflow must be gone");
});
