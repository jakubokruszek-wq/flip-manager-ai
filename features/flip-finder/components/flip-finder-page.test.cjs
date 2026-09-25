/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "flip-finder-page.tsx"), "utf8");
const inlineResults = fs.readFileSync(path.join(__dirname, "inline-filter-results.tsx"), "utf8");
const galleryRoute = fs.readFileSync(path.join(__dirname, "../../../app/api/flip-finder/listings/[id]/gallery/route.ts"), "utf8");
const galleryTraceRoute = fs.readFileSync(path.join(__dirname, "../../../app/api/flip-finder/listings/[id]/gallery/trace/route.ts"), "utf8");
const galleryTraceStore = fs.readFileSync(path.join(__dirname, "../server/gallery-request-trace.ts"), "utf8");
const galleryTraceMigration = fs.readFileSync(path.join(__dirname, "../../../supabase/migrations/20260906133000_create_gallery_request_traces.sql"), "utf8");
const galleryTraceProbeMigration = fs.readFileSync(path.join(__dirname, "../../../supabase/migrations/20260906143000_extend_gallery_request_traces_render_probe.sql"), "utf8");
const galleryTraceNativeMigration = fs.readFileSync(path.join(__dirname, "../../../supabase/migrations/20260906150000_extend_gallery_request_traces_native_events.sql"), "utf8");
const galleryJobs = fs.readFileSync(path.join(__dirname, "../../facebook-worker/gallery-jobs.ts"), "utf8");
const galleryRetryMigration = fs.readFileSync(path.join(__dirname, "../../../supabase/migrations/20260907090000_atomic_gallery_retry_enqueue.sql"), "utf8");
const historyRoute = fs.readFileSync(path.join(__dirname, "../../../app/api/flip-finder/history/route.ts"), "utf8");

test("normal Flip Finder UI uses the queue scan result funnel", () => {
  assert.match(page, /WYNIK OSTATNIEGO SKANU/);
  // Stale assertion, traced via `git log -S` to commit ab285b3 ("deterministic
  // scan accounting and extraction recovery V1"): that commit intentionally
  // condensed the funnel to compact single/two-word labels (documented in the
  // component's own comment, "Zebrane -> Tożsamość OK -> Sprzedaż mieszkań ->
  // Odrzucone twardo -> Do oceny -> Dopasowane") but this test was never
  // updated to match, leaving three assertions checking pre-condensation copy
  // that has not existed in the implementation since. Restoring the old copy
  // would revert an intentional UI change; these three lines are corrected to
  // the implementation's own current, documented labels instead.
  assert.match(page, /Zebrane/);
  assert.match(page, /Tożsamość OK/);
  assert.match(page, /Sprzedaż mieszkań/);
  assert.match(page, /Odrzucone twardo/);
  assert.match(page, /Do oceny/);
  assert.match(page, /hardRejectedUnique/);
  assert.doesNotMatch(page, /Math\.max\(0, collected - matched\)/);
  // Same ab285b3 redesign: the old all-caps "ODRZUCONE" section heading and
  // the "Nowe zapisane oferty"/"Zaktualizowane" metric labels were replaced by
  // "Dlaczego odrzucone?" and "Globalnie nowe oferty"/"Aktualizacje"
  // respectively. The old empty-scan footnote text is now generated
  // dynamically by scanNoOffersMessage() (features/flip-finder/dashboard.ts,
  // wording and pluralization already covered by that function's own tests),
  // so the static-source check here verifies the call is actually wired into
  // this panel instead of matching literal message text that no longer
  // exists as inline JSX.
  assert.match(page, /Dlaczego odrzucone\?/);
  assert.match(page, /Globalnie nowe oferty/);
  assert.match(page, /Aktualizacje/);
  assert.match(page, /scanNoOffersMessage\(funnel\.saved, funnel\.topRejection\)/);
  assert.match(page, /Szczegóły diagnostyczne/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void validateCollector\(activeFilter\)\}/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void testDirectExternalChannel\(\)\}/);
  assert.doesNotMatch(page, /\{collectorValidation \? <CollectorValidationPanel/);
  assert.doesNotMatch(page, /\{externalPingResult \? <div/);
});

test("saved listings database is labeled independently from the latest scan", () => {
  assert.match(inlineResults, /BAZA OFERT/);
  assert.match(inlineResults, /AKTYWNE \/ DOPASOWANE/);
  assert.doesNotMatch(inlineResults, /AKTYWNE \/ MATCHED/);
  assert.match(inlineResults, /Aktywne zapisane oferty:/);
  assert.doesNotMatch(inlineResults, /Znalezione oferty:/);
});

test("Finder keeps offer results primary and hides filter configuration until requested", () => {
  assert.match(page, /Ustawienia filtra/);
  assert.match(page, /<details className="relative">[\s\S]*FilterActions filter=\{activeFilter\}/);
  assert.match(inlineResults, /Źródła i historia skanów/);
  assert.match(inlineResults, /Historia wyszukiwania i działania/);
  assert.match(inlineResults, /function QuickInvestmentPreview/);
  assert.doesNotMatch(inlineResults, /import \{ InvestmentDesk \}/);
});

test("Finder exposes a keyboard-accessible one-click Deal Room route outside the expandable card control", () => {
  assert.match(inlineResults, /import Link from "next\/link"/);
  assert.match(inlineResults, /href=\{`\/deals\/\$\{encodeURIComponent\(result\.id\)\}`\}>Otwórz Deal Room/);
  const listingArticle = inlineResults.indexOf('<article className="ui-card ui-card-hover group overflow-hidden !border-transparent hover:!border-transparent">');
  const dealRoomCta = inlineResults.indexOf("Otwórz Deal Room", listingArticle);
  const expandableButton = inlineResults.indexOf('<button aria-expanded={expanded}', listingArticle);
  assert.ok(listingArticle >= 0 && dealRoomCta > listingArticle && expandableButton > dealRoomCta, "the gold Deal Room CTA must precede, and remain outside, the expandable button");
  assert.match(inlineResults, /inline-flex min-h-10 items-center rounded-xl bg-gold/);
  assert.match(inlineResults, /focus-visible:ring-2/);
  assert.doesNotMatch(inlineResults, /role="button"\s+tabIndex=\{0\}/);
});

test("search history can be cleared explicitly without deleting filters or sources", () => {
  assert.match(inlineResults, /Wyczyść historię wyszukiwania/);
  assert.match(inlineResults, /window\.confirm\(/);
  assert.match(inlineResults, /fetch\("\/api\/flip-finder\/history"/);
  assert.match(inlineResults, /method: "DELETE"/);
  assert.doesNotMatch(inlineResults, /x-flip-finder-action/);
  assert.match(historyRoute, /await requireOperator\(\)/);
  assert.match(historyRoute, /HISTORY_CLEAR_SCAN_ACTIVE/);
  assert.match(historyRoute, /from\("listings"\)/);
  assert.match(historyRoute, /\.delete\(\)/);
  assert.doesNotMatch(historyRoute, /from\("search_filters"\).*delete/);
  assert.doesNotMatch(historyRoute, /from\("watched_facebook_sources"\).*delete/);
  assert.match(historyRoute, /createAdminClient/);
});

test("archive is opt-in and fetched separately from the main finder", () => {
  assert.match(inlineResults, /Historia ofert/);
  assert.match(inlineResults, /view=archive/);
  // Semantic properties (see also results.test.ts, which exercises the real
  // sortResults(...) call this expression makes, behaviorally): archive stays
  // empty while collapsed, and once opened it is sorted, not just passed
  // through raw — using the currently selected `sort` state, not a fixed one.
  assert.match(inlineResults, /archiveOpen \? sortResults\(data\?\.archivedResults \?\? \[\], sort\) : \[\]/, "archive must be sorted with the live `sort` state, and empty while collapsed");
  assert.match(inlineResults, /const archivedResults = useMemo\(\(\) => archiveOpen \? sortResults\([^;]+\[archiveOpen, data\?\.archivedResults, sort\]\)/, "the memo must recompute when the selected sort changes, not only when archiveOpen/data change");
  assert.doesNotMatch(inlineResults, /<h2 className="font-semibold">ARCHIWUM<\/h2>/);
});

test("review counter and rendered cards use the same current-filter dataset", () => {
  assert.match(inlineResults, /Potencjalne oferty bez kompletu danych: \{reviewCount\}/);
  assert.match(inlineResults, /visibleReviewResults = sortedReviewResults/);
  assert.match(inlineResults, /visibleReviewResults\.map\(\(result\) => <ReviewListingCard/);
  assert.match(inlineResults, /counts\?: \{ active: number; review: number; archived: number \}/);
});

test("review cards expose safe image and persisted source provenance", () => {
  assert.match(inlineResults, /result\.thumbnailUrl \? <SafeImage/);
  assert.match(inlineResults, /sourceLabelForResult\(result\.source\)/);
  assert.match(inlineResults, /firstSeenLabel\(result\.firstSeenAt\)/);
  assert.match(inlineResults, /publicationLabel\(result\.publishedAt\)/);
  assert.doesNotMatch(inlineResults, /target="_blank">Facebook <ExternalLink/);
});

test("Facebook cards expose an explicit, non-blocking on-demand gallery request", () => {
  assert.equal((inlineResults.match(/function GalleryRequestButton\(/g) || []).length, 1);
  assert.match(page, /<InlineFilterResults[^>]+filterId=\{activeFilter\.id\}/);
  assert.match(inlineResults, /POBIERZ ZDJĘCIA|POBIERZ ZDJ/);
  assert.match(inlineResults, /listings\/\$\{result\.id\}\/gallery/);
  assert.match(inlineResults, /GALLERY_UI_CLICK/);
  assert.match(inlineResults, /GALLERY_HANDLER_ENTER/);
  assert.match(inlineResults, /GALLERY_GUARD_PASS/);
  assert.match(inlineResults, /GALLERY_FETCH_START/);
  assert.match(inlineResults, /GALLERY_FETCH_RESPONSE/);
  assert.match(inlineResults, /GALLERY_FETCH_ERROR/);
  assert.match(inlineResults, /GALLERY_BUTTON_POINTER_CAPTURE/);
  assert.match(inlineResults, /GALLERY_CARD_POINTER_CAPTURE/);
  assert.match(inlineResults, /GALLERY_BUTTON_CLICK_CAPTURE/);
  assert.match(inlineResults, /GALLERY_CARD_CLICK_CAPTURE/);
  assert.match(inlineResults, /GALLERY_BUTTON_RENDERED/);
  assert.match(inlineResults, /cache: "no-store"/);
  assert.match(inlineResults, /GALLERY_NATIVE_POINTER_CAPTURE/);
  assert.match(inlineResults, /GALLERY_NATIVE_CLICK_CAPTURE/);
  assert.match(inlineResults, /GALLERY_CLIENT_EXCEPTION/);
  assert.match(inlineResults, /GALLERY_BUTTON_MOUNT/);
  assert.match(inlineResults, /GALLERY_BUTTON_UNMOUNT/);
  assert.match(inlineResults, /GalleryRequestButton/);
  assert.match(inlineResults, /void onChangedRef\.current\?\.\(\)/);
  assert.match(inlineResults, /Pobrano \$\{persisted\} zdjęć · pobierz pozostałe/);
  assert.match(inlineResults, /result\.images\.length > 1/);
  assert.match(inlineResults, /buttonRendered: true/);
  assert.match(inlineResults, /CLIENT_BUILD_ID/);
  assert.match(inlineResults, /result\.source/);
  assert.match(inlineResults, /onPointerDownCapture/);
  assert.match(inlineResults, /onClickCapture/);
  assert.match(inlineResults, /targetTag/);
  assert.match(inlineResults, /currentTargetTag/);
  assert.match(inlineResults, /listings\/\$\{entry\.listingId\}\/gallery\/trace/);
  assert.match(inlineResults, /credentials: "same-origin"/);
  assert.match(inlineResults, /event\.stopPropagation\(\)/);
  assert.match(inlineResults, /data-gallery-action="request"/);
  assert.match(inlineResults, /data-gallery-request-button="true"/);
  assert.match(inlineResults, /data-gallery-trace-id/);
  assert.match(inlineResults, /data-gallery-instance-id/);
  assert.match(inlineResults, /document\.addEventListener\("pointerdown", pointerListener, true\)/);
  assert.match(inlineResults, /document\.addEventListener\("click", clickListener, true\)/);
  assert.match(inlineResults, /inFlightRef/);
  assert.match(galleryRoute, /enqueueFacebookGalleryJob/);
  assert.match(galleryRoute, /getFacebookGalleryStatus/);
  assert.match(inlineResults, /setInterval\(\(\) => void poll\(\), 2_000\)/);
  assert.match(galleryJobs, /\.rpc\("enqueue_facebook_gallery_job"/);
  assert.match(galleryRetryMigration, /'GALLERY_HYDRATION'/);
  assert.match(galleryRetryMigration, /\n    100,/);
  assert.match(galleryJobs, /EXACT_ROOT_STORY/);
});

test("gallery mutation is protected by the shared operator session", () => {
  assert.match(galleryRoute, /await requireOperator\(\)/);
  assert.doesNotMatch(inlineResults, /x-flip-finder-action/);
  assert.match(galleryTraceRoute, /await requireOperator\(\)/);
  assert.match(galleryTraceRoute, /FLIP_GALLERY_SERVER_TRACE/);
  assert.match(galleryTraceRoute, /GALLERY_TRACE_TOO_LARGE/);
  assert.match(galleryTraceStore, /GALLERY_BUTTON_POINTER_CAPTURE/);
  assert.match(galleryTraceStore, /GALLERY_CARD_POINTER_CAPTURE/);
  assert.match(galleryTraceStore, /GALLERY_BUTTON_CLICK_CAPTURE/);
  assert.match(galleryTraceStore, /GALLERY_CARD_CLICK_CAPTURE/);
  assert.match(galleryTraceRoute, /readGalleryTraces/);
  assert.match(galleryTraceRoute, /writeGalleryTrace/);
  assert.doesNotMatch(galleryTraceRoute, /authorizeGalleryTrace|authorizeGalleryTraceRead/);
});

test("render-time gallery probe is durable, bounded, and non-business-mutating", () => {
  assert.match(galleryTraceProbeMigration, /add column if not exists source text/);
  assert.match(galleryTraceProbeMigration, /add column if not exists client_build text/);
  assert.match(galleryTraceProbeMigration, /add column if not exists component text/);
  assert.match(galleryTraceProbeMigration, /add column if not exists button_rendered boolean/);
  assert.match(galleryTraceProbeMigration, /GALLERY_BUTTON_RENDERED/);
  assert.match(galleryTraceProbeMigration, /enable row level security/);
  assert.match(galleryTraceProbeMigration, /revoke all on table public\.gallery_request_traces from anon, authenticated/);
  assert.match(galleryTraceProbeMigration, /grant select, insert on table public\.gallery_request_traces to service_role/);
  assert.match(galleryTraceStore, /client_build/);
  assert.match(galleryTraceStore, /button_rendered/);
  assert.match(galleryTraceStore, /isRenderProbeSchemaMissing/);
  assert.match(galleryTraceStore, /legacyQuery/);
});

test("gallery trace storage is backend-only and does not mutate business state", () => {
  assert.match(galleryTraceMigration, /create table if not exists public\.gallery_request_traces/);
  assert.match(galleryTraceMigration, /alter table public\.gallery_request_traces enable row level security/);
  assert.match(galleryTraceMigration, /revoke all on table public\.gallery_request_traces from anon, authenticated/);
  assert.match(galleryTraceMigration, /grant select, insert on table public\.gallery_request_traces to service_role/);
  assert.doesNotMatch(galleryTraceMigration, /grant .* to anon|grant .* to authenticated/);
  assert.match(galleryTraceStore, /MAX_TRACE_ROWS = 80/);
  assert.match(galleryTraceRoute, /export async function GET/);
});

test("native gallery diagnostics are bounded, backend-only, and failure-isolated", () => {
  assert.match(inlineResults, /function dispatchGalleryTrace/);
  assert.match(inlineResults, /A synchronous fetch\/serialization failure must not escape/);
  assert.match(inlineResults, /Snapshot every SyntheticEvent field synchronously/);
  assert.match(inlineResults, /closest\<HTMLElement\>\('\[data-gallery-request-button="true"\]'/);
  assert.match(galleryTraceStore, /instanceId: boundedString\("instanceId", 80\)/);
  assert.match(galleryTraceStore, /errorMessage: boundedString\("errorMessage", 160\)/);
  assert.match(galleryTraceNativeMigration, /GALLERY_NATIVE_POINTER_CAPTURE/);
  assert.match(galleryTraceNativeMigration, /GALLERY_NATIVE_CLICK_CAPTURE/);
  assert.match(galleryTraceNativeMigration, /GALLERY_CLIENT_EXCEPTION/);
  assert.match(galleryTraceNativeMigration, /char_length\(error_message\) between 1 and 160/);
  assert.match(galleryTraceNativeMigration, /enable row level security/);
  assert.match(galleryTraceNativeMigration, /revoke all on table public\.gallery_request_traces from anon, authenticated/);
  assert.match(galleryTraceNativeMigration, /revoke update, delete on table public\.gallery_request_traces from service_role/);
  assert.match(galleryTraceNativeMigration, /grant select, insert on table public\.gallery_request_traces to service_role/);
  assert.doesNotMatch(galleryTraceNativeMigration, /grant .* to anon|grant .* to authenticated/);
});

// Scan accounting V1, Part H: the scan-results diagnostics were an 11-tile
// KPI grid using two conflicting reason-code vocabularies (hardRejectReasons'
// canonical camelCase keys vs rejectionBreakdown's older keys), so "Dlaczego
// odrzucone?" could show its "no data" placeholder even when real reason data
// existed under the other shape, and there was no visible funnel structure
// or extraction-failure count at all.
test("the scan-results panel renders one compact funnel plus separated technical/business tiles, and never loses reason data to a key-shape mismatch", () => {
  assert.match(page, /aria-label="Lejek skanu"/, "the funnel must be a single, labeled, readable-at-a-glance row");
  assert.equal((page.match(/<FunnelStep /g) ?? []).length, 6, "Zebrane -> Tożsamość OK -> Sprzedaż mieszkań -> Odrzucone twardo -> Do oceny -> Dopasowane, exactly 6 steps");
  assert.doesNotMatch(page, /Zweryfikowana tożsamość/, "the old 11-tile flat grid duplicating the funnel's own steps must be gone");
  assert.match(page, /const extractionFailed = \(response\.warnings \?\? \[\]\)\.filter\(\(warning\) => warning\.startsWith\("Post nie został przetworzony:"\)\)\.length;/, "extraction-failure count must come from the response's own warnings, never a fabricated number");
  assert.match(page, /Dlaczego odrzucone\?/);
  assert.match(page, /numberFromAny\(hardReasons, \[key as string, \.\.\.\(aliases as string\[\]\)\], numberFromAny\(breakdown, \[key as string, \.\.\.\(aliases as string\[\]\)\], 0\)\)/, "every canonical reason must be looked up under BOTH known key shapes before falling back to zero, so a real count under either shape is never silently dropped");
});
