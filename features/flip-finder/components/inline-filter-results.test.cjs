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

// Price-per-m² mission (superseded): the REVIEW bucket used to have its own
// separate component (ReviewListingCardContent) with an independent, ad-hoc
// price formatter. That whole component is gone -- REVIEW now renders
// through the exact same ExpandableListingCard as MATCHED and every Watcher
// card, so it gets the shared currency()/currencyPerSqm() presentation (and
// every other detail-view fix) automatically, with no separate formatter to
// drift out of sync ever again.
test("the REVIEW bucket card renders through the same ExpandableListingCard as MATCHED, never its own separate price formatter", () => {
  assert.doesNotMatch(page, /function ReviewListingCardContent\(/, "the old, separate REVIEW detail component must not exist");
  assert.doesNotMatch(page, /new Intl\.NumberFormat\("pl-PL", \{ maximumFractionDigits: 0 \}\)\.format\(result\.price\)/, "the old ad-hoc price formatter must be gone");
  const start = page.indexOf("function ReviewListingCard(");
  assert.ok(start >= 0, "ReviewListingCard must exist");
  const source = page.slice(start, page.indexOf("\n}\n", start));
  assert.match(source, /<ExpandableListingCard autoOpen=\{autoOpen\} averagePricePerSqm=\{averagePricePerSqm\} filter=\{filter \?\? null\} marketType=\{marketType\} onChanged=\{onChanged\} result=\{result\} \/>/, "ReviewListingCard must delegate its entire card/price/detail rendering to the shared ExpandableListingCard");
});

test("currency/currencyPerSqm formatting is unchanged: Polish locale, PLN currency, no decimals", () => {
  assert.match(page, /new Intl\.NumberFormat\("pl-PL", \{ style: "currency", currency: "PLN", maximumFractionDigits: 0 \}\)/);
  assert.match(page, /function currencyPerSqm\(value: number \| null\): string \{ const formatted = currency\(value\); return formatted === "—" \? formatted : `\$\{formatted\}\/m²`; \}/);
});

// Hotfix D (superseded): a push/alert deep link for a REVIEW listing used to
// be silently ignored because ReviewListingCard never consumed
// deepLinkListingId, only scrolling/ring-highlighting its own separate card
// on a match. REVIEW now renders through the exact same ExpandableListingCard
// as MATCHED, so the deep link uses the identical, stronger autoOpen contract
// (which opens the full detail dialog directly) instead of a bespoke
// scroll-only effect -- never moving the listing out of its canonical bucket.
test("REVIEW deep link uses the same autoOpen contract as MATCHED, opening the full detail dialog directly", () => {
  assert.doesNotMatch(page, /function ReviewListingCardContent\(/, "the old, separate REVIEW detail component (and its bespoke scroll/highlight effect) must not exist");
  const start = page.indexOf("function ReviewListingCard(");
  assert.ok(start >= 0, "ReviewListingCard must exist");
  const source = page.slice(start, page.indexOf("function QuickInvestmentPreview(", start));
  assert.match(source, /function ReviewListingCard\(\{ result, onChanged, autoOpen = false, averagePricePerSqm, marketType, filter \}:/, "ReviewListingCard must accept the same optional autoOpen prop MATCHED cards use");
  assert.match(source, /<ExpandableListingCard autoOpen=\{autoOpen\}/, "ReviewListingCard must forward autoOpen straight into the shared ExpandableListingCard, not a separate scroll effect");
  assert.match(page, /<ReviewListingCard autoOpen=\{result\.id === deepLinkListingId\}/, "the review results list must wire autoOpen to the exact same deepLinkListingId contract already used for MATCHED cards");
});

// Regression guard for the pre-existing MATCHED deep link (Task 3): must be
// byte-identical to before this hotfix — this patch only adds REVIEW support
// alongside it, never touches the MATCHED path.
test("non-Facebook MATCHED deep link has no regression: autoOpen is still wired to the same deepLinkListingId contract", () => {
  assert.match(page, /<ExpandableListingCard autoOpen=\{result\.id === deepLinkListingId\} averagePricePerSqm=\{data\?\.filter\.maxPricePerSqm \?\? null\} filter=\{data\?\.filter \?\? null\} key=\{result\.id\} marketType=\{data\?\.filter\.marketType \?\? null\} onChanged=\{\(\) => void load\(\)\} result=\{result\} \/>/);
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
  assert.match(source, /const wrapperBorderClassName = props\.variant === "watcher" \? "" : FINDER_CARD_BORDER_CLASSNAME;/, "the border must be computed from variant, empty only for \"watcher\", so the standalone Finder usage keeps its own single, stronger (2px, 55%->80%) border");
  assert.match(source, /return <div className=\{wrapperBorderClassName\} data-listing-id=\{props\.result\.id\} data-testid="finder-card" onClickCapture=\{handleCardClickCapture\} onPointerDownCapture=\{handleCardPointerCapture\}/, "the wrapper (top card + bottom panel) must carry the computed border class, not display:contents");
  assert.doesNotMatch(source, /<div className="contents" onClickCapture=\{handleCardClickCapture\}/, "the old display:contents wrapper (which cannot paint a border) must be gone from ExpandableListingCard specifically");
  assert.match(page, /<article className="ui-card ui-card-hover group overflow-hidden !border-transparent hover:!border-transparent">/, "the inner article's own border must be suppressed so it never doubles the outer one");
});

// Gold-border-consistency mission (superseded): ReviewListingCard used to
// paint its own separate border via a duplicated wrapper. It no longer draws
// any border of its own at all -- REVIEW now renders through the exact same
// ExpandableListingCard as MATCHED, which already owns FINDER_CARD_BORDER_
// CLASSNAME as its single source of truth, so the two variants can never
// drift apart again.
test("ReviewListingCard draws no border of its own; the single gold border comes entirely from the shared ExpandableListingCard", () => {
  assert.match(page, /const FINDER_CARD_BORDER_CLASSNAME = "overflow-hidden rounded-\[1\.125rem\] !border-2 !border-gold\/55 transition-colors duration-300 focus-within:!border-gold\/80 hover:!border-gold\/80";/, "one shared constant must be the single source of truth for this border, reused rather than duplicated");
  const start = page.indexOf("function ReviewListingCard(");
  assert.ok(start >= 0, "ReviewListingCard must exist");
  const source = page.slice(start, page.indexOf("function QuickInvestmentPreview(", start));
  assert.doesNotMatch(source, /FINDER_CARD_BORDER_CLASSNAME/, "ReviewListingCard must not reference the border class directly -- it must come only from the ExpandableListingCard it renders");
  assert.doesNotMatch(source, /data-testid="finder-card"/, "ReviewListingCard must not define its own competing finder-card wrapper -- the shared ExpandableListingCard already owns exactly one");
  assert.doesNotMatch(source, /className="contents"/, "the old display:contents wrapper, which cannot paint a border at all, must be gone");
  assert.doesNotMatch(page, /border-amber-400\/25/, "the old, separate, weaker amber border must be gone from the whole file");
});

test("opening a card notifies the parent outside React's state updater", () => {
  const source = fs.readFileSync(path.join(__dirname, "inline-filter-results.tsx"), "utf8");
  assert.match(source, /const toggle = \(\) => \{\s*if \(!expanded\) onOpen\?\.\(\);\s*setExpanded\(\(current\) => !current\);\s*\};/);
  assert.doesNotMatch(source, /setExpanded\(\(current\) => \{\s*if \(!current\) onOpen\?\.\(\);/);
});

// Superseded by the mission that eliminated REVIEW's separate detail view:
// MATCHED and REVIEW used to expose two independently-implemented keyboard
// entry points (ExpandableListingCardContent's toggle button vs. REVIEW's own
// handleCardClick/handleCardKeyDown pair). REVIEW now renders through
// ExpandableListingCard directly, so there is exactly one entry point -- the
// shared toggle <button> -- and no REVIEW-specific keyboard handling left to
// keep in sync with it.
test("MATCHED and REVIEW cards share the exact same keyboard-safe analysis entry point -- there is only one implementation, not two", () => {
  assert.match(page, /variant === "watcher" \? null : <div className="flex justify-end px-3 pb-4 sm:px-5">/, "Finder MATCHED cards must expose an explicit Analizuj action without adding it to the Watcher variant");
  assert.match(page, /<Button aria-expanded=\{expanded\}.*?>Analizuj<\/Button>/, "the MATCHED Analizuj button must open the controlled dialog");
  assert.match(page, /<button aria-expanded=\{expanded\} className="block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick=\{toggle\} type="button">/, "the shared card-body toggle button (the same one Watcher uses) must exist");
  assert.doesNotMatch(page, /\bhandleCardClick\b|\bhandleCardKeyDown\b|\banalysisExpanded\b|function ReviewListingCardContent\(/, "REVIEW must not define its own separate click/keydown/expand handling -- it must use the exact same toggle button as MATCHED and Watcher");
  const start = page.indexOf("function ReviewListingCard(");
  assert.ok(start >= 0, "ReviewListingCard must exist");
  const source = page.slice(start, page.indexOf("function QuickInvestmentPreview(", start));
  assert.match(source, /<ExpandableListingCard autoOpen=\{autoOpen\}/, "REVIEW's only detail-view entry point must be the shared ExpandableListingCard");
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

// Real production bug: a rejected offer's card showed the bare internal
// reason code (e.g. "max_price_per_sqm") instead of a specific, readable
// sentence with real numbers -- or, once filter thresholds changed, a stale
// reason left over from a previous, different limit. The reasons list is now
// built from a fresh, per-request translation (rejection-reasons.ts),
// against the filter's CURRENT criteria, never the raw persisted codes.
test("a rejected/reviewed offer shows specific, human-readable reasons — never the bare internal code — computed fresh against the current filter", () => {
  assert.match(page, /import \{ describeRejectionReason \} from "@\/features\/flip-finder\/rejection-reasons";/);
  assert.match(page, /function realRejectionReasons\(result: FilterResult, filter: SearchFilter\): string\[\] \{/, "a dedicated helper must translate reasons, not inline logic scattered at the call site");
  assert.match(page, /realReasons\.map\(\(reason\) => describeRejectionReason\(reason, result, filter\)\)/, "each real reason must be translated through describeRejectionReason with the live result and filter — never a stale, pre-computed string");
  assert.match(page, /result\.matchReasons\.filter\(\(reason\) => reason !== "review" && !reason\.startsWith\("unknown_"\)\)/, "internal bookkeeping markers (review/unknown_*) must never be shown as if they were real reasons");
  assert.match(page, /label=\{result\.decisionBucket === "REJECTED" \? "Powody odrzucenia" : "Powody dopasowania"\}/, "a rejected offer must be labeled as a rejection, not the generic match-reasons heading");
  assert.match(page, /values=\{filter \? realRejectionReasons\(result, filter\) : result\.matchReasons\}/, "the translated reasons must actually be what's rendered whenever the filter is available");
});
