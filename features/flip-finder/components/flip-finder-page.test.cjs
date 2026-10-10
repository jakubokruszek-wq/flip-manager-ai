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
  assert.match(inlineResults, /Widoczne oferty:/);
  assert.match(inlineResults, /Razem · Dopasowane: \$\{sourceCounts\.total\.matched\} · Do oceny: \$\{sourceCounts\.total\.review\}/);
  assert.doesNotMatch(inlineResults, /Aktywne zapisane oferty:/);
  assert.doesNotMatch(inlineResults, /Znalezione oferty:/);
});

test("filter dashboard labels its canonical visible result count separately from last-scan telemetry", () => {
  assert.match(page, /Widoczne oferty: \{formatNumber\(filter\.totalMatches \?\? 0\)\}/);
  assert.match(page, /Nowe w ostatnim skanie: \{formatNumber\(filter\.newMatches \?\? 0\)\}/);
  assert.doesNotMatch(page, /Zapisane powiązania: \{formatNumber\(filter\.totalMatches/);
  assert.doesNotMatch(page, /Wszystkie dopasowania: \{formatNumber\(filter\.totalMatches/);
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

// REVIEW now renders through the exact same ExpandableListingCard as
// MATCHED, so it automatically gets the same real photo (or placeholder),
// timestamps and source badge/provenance -- with no separate, REVIEW-only
// implementation of any of them left to drift out of sync.
test("review cards expose safe image and persisted source provenance through the same shared card as MATCHED", () => {
  assert.match(inlineResults, /result\.thumbnailUrl \? \(\s*<SafeImage/, "the shared card must render a real photo when one exists");
  assert.match(inlineResults, /firstSeenLabel\(result\.firstSeenAt\)/);
  assert.match(inlineResults, /publicationLabel\(result\.publishedAt\)/);
  assert.doesNotMatch(inlineResults, /target="_blank">Facebook <ExternalLink/);
  assert.doesNotMatch(inlineResults, /sourceLabelForResult/, "the old REVIEW-only source label helper must be gone -- provenance now comes from the shared card's own SourceBadge");
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

// UI-only change: the rejection-reason diagnostics (the technical/business
// exclusion tiles, "Dlaczego odrzucone?", "Wyniki wyszukiwania", and the old
// separate "Szczegóły diagnostyczne" <details>) are now one single
// collapsible panel, collapsed by default, so a scan result isn't dominated
// by diagnostic clutter -- while the filter name, status, and funnel
// (including "Zebrane") stay unconditionally visible. No counter, value, or
// decision logic changed; only where each one renders.
test("rejection diagnostics collapse into one panel, closed by default, with correct aria-expanded/aria-controls and native keyboard support", () => {
  const componentBody = page.match(/function RejectionDiagnostics\([\s\S]*?\n\}/)?.[0];
  assert.ok(componentBody, "RejectionDiagnostics component must exist");

  assert.match(componentBody, /const \[open, setOpen\] = useState\(false\)/, "the panel must start collapsed (open=false)");
  assert.match(componentBody, /const panelId = useId\(\)/, "aria-controls must reference a real, unique id, not a hardcoded string shared across scan cards");

  // A real <button>, not a clickable div/span -- Enter and Space activate a
  // native button without any extra keydown handling.
  assert.match(componentBody, /<button[\s\S]*?type="button"/);
  assert.match(componentBody, /aria-expanded=\{open\}/);
  assert.match(componentBody, /aria-controls=\{panelId\}/);
  assert.match(componentBody, /onClick=\{\(\) => setOpen\(\(value\) => !value\)\}/, "clicking must toggle open, both expanding and collapsing");

  // The controlled panel's own id must be the exact id aria-controls points
  // to, and the panel must only be in the DOM while open (never present-but-
  // hidden), matching a correct disclosure-button pattern.
  assert.match(componentBody, /id=\{panelId\}/);
  assert.match(componentBody, /\{open \? \(/, "the panel content must be conditionally rendered on the same `open` state the button toggles");

  // Everything moved into the panel is still present, unchanged, and still
  // sourced from the same funnel/response the always-visible funnel above
  // uses -- nothing here is a second, divergent copy of the data.
  for (const moved of ["DiagnosticMetric label=\"Tożsamość niezweryfikowana\"", "Dlaczego odrzucone?", "Wyniki wyszukiwania", "Szczegóły diagnostyczne", "SourceDiagnosticCard", "technicalDiagnosticBars(response.matchDiagnostics, funnel.collected)"]) {
    assert.ok(componentBody.includes(moved), `expected "${moved}" inside RejectionDiagnostics`);
  }

  // The always-visible core (filter name, status badge, funnel including
  // "Zebrane") must remain directly in ScanResultPanel, never moved behind
  // the collapse.
  const scanResultPanelBody = page.match(/function ScanResultPanel\([\s\S]*?\n\}/)?.[0];
  assert.ok(scanResultPanelBody, "ScanResultPanel must exist");
  assert.match(scanResultPanelBody, /\{filter\.name\}/);
  assert.match(scanResultPanelBody, /scanRunStatusLabel\(status\)/);
  assert.match(scanResultPanelBody, /<FunnelStep label="Zebrane" value=\{funnel\.collected\} \/>/);
  assert.match(scanResultPanelBody, /<RejectionDiagnostics funnel=\{funnel\} response=\{response\} \/>/, "the collapsible panel must actually be rendered inside the scan result card");
  assert.doesNotMatch(scanResultPanelBody, /<details/, "the old separate native <details> disclosure must be gone, folded into the one new panel");
});

// Finder/Watcher separation mission: Finder's own scan-result card for
// source="facebook" is always reconcileFacebookFromCanonicalListings's
// output (a re-evaluation of canonical listings Watcher already saved) --
// it never scans Facebook itself. A label implying live Watcher activity
// ("Facebook Watcher — zebrane oferty") misled operators into believing a
// scan/scroll/collect step had just run on Facebook after clicking Finder's
// own "Skanuj" button.
test("the Finder scan-result card never labels a facebook source result as Facebook Watcher activity", () => {
  const sourceDisplayLabelBody = page.match(/function sourceDisplayLabel\(value: string\): string \{[\s\S]*?\}/)?.[0];
  assert.ok(sourceDisplayLabelBody, "sourceDisplayLabel must exist");
  assert.doesNotMatch(sourceDisplayLabelBody, /Facebook Watcher/, "the scan-result card's own source label may never claim Watcher activity ran from a Finder scan");
  assert.match(sourceDisplayLabelBody, /value === "facebook" \? "Facebook — przeliczono z zapisanych ofert" : value/, "the facebook label must describe a recalculation from already-saved offers, not a live scan");
  // The one legitimate "Facebook Watcher" mention left in this file must be
  // about a genuinely separate, concurrently-running background job (the
  // Watcher's own scheduled scan), never implied by anything a Finder-
  // triggered scan itself did.
  assert.match(page, /setNotice\("Facebook Watcher zbiera jeszcze nowe oferty w tle\. Pozostałe źródła zakończyły swój bieżący przebieg\.".*\);/, "the remaining Facebook Watcher mention must describe real, separate background work, not something this scan did");
});

// Production proof (screenshot, 2026-09-27): clicking Finder's "Skanuj" was
// NOT the only way its scan panel could start showing live progress. An
// auto-poll effect used to run on every page load/data-refresh and follow
// activeFilter.lastScan.scanRunId -- the most recent source_scans row for
// the filter from ANY origin, including a facebook_scan_jobs-backed run the
// Facebook Watcher's own independent scheduler started on its own cadence
// (see features/facebook-worker/scheduler.ts). That let a concurrent
// Watcher run "leak" into Finder's UI with zero clicks: real group names,
// real post counts, real collector-queue timeouts, exactly what the
// production screenshot showed. Automatic observation now uses a dedicated
// Finder-only GET discovery, alongside the explicit manual start ACK.
test("scanProgress uses explicit Finder discovery or a manual ACK, never activeFilter.lastScan", () => {
  // Strip `//` line comments first: the removed effect's own explanatory
  // comment names "lastScan.scanRunId" in prose, which must not itself trip
  // this check meant to catch live CODE reading that value.
  const codeOnly = page.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /lastScan\.scanRunId/, "no code path may read a filter's lastScan.scanRunId into Finder's live scan state");
  assert.doesNotMatch(codeOnly, /activeFilter(?:\??)\.lastScan/, "activeFilter.lastScan may only feed a static, non-live display (e.g. an 'Ostatni skan' timestamp), never scanProgress/activeScanRunId state");

  const setActiveScanRunIdCalls = [...page.matchAll(/setActiveScanRunId\(([^)]*)\)/g)].map((match) => match[1].trim());
  assert.deepEqual(setActiveScanRunIdCalls.sort(), ["null", "payload.runId"].sort(), "manual monitoring follows only its own ACK");
  assert.match(codeOnly, /setObservedRun\(\{ filterId: selectedFilterId, progress \}\)/, "observation state must be isolated from a manual run for another filter");
  assert.match(codeOnly, /observeFinderRuns\(selectedFilterId, controller.signal/);
  assert.doesNotMatch(codeOnly, /data.latestScan/);

  // The catalogue loader stays independent of lightweight observation.
  const mountEffectBody = page.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[load\]\);/)?.[0];
  assert.ok(mountEffectBody, "the mount-time load effect must exist");
  assert.doesNotMatch(mountEffectBody, /setScanProgress|setActiveScanRunId/, "the mount-time effect may only call load(), never touch live scan state");
});

// Strict separation mission requirement: Finder must never open Facebook,
// never open a Facebook group, never talk to the browser extension directly
// (chrome.tabs/chrome.runtime), and never send it a command. Its only
// browser-extension contact anywhere in this file is the pre-existing,
// unrelated "collector bridge" (document.dispatchEvent/addEventListener of
// same-page CustomEvents, used by validateCollector's separate "sprawdź
// gotowość" action) -- itself never a chrome.* call, and never invoked by
// scanFilter, the function "Skanuj" actually calls.
test("Finder never references a facebook.com URL or the chrome.tabs/chrome.runtime extension APIs anywhere in this file", () => {
  assert.doesNotMatch(page, /facebook\.com/, "Finder must never construct or reference a facebook.com URL");
  assert.doesNotMatch(page, /chrome\.tabs/, "Finder must never call chrome.tabs");
  assert.doesNotMatch(page, /chrome\.runtime\.sendMessage/, "Finder must never call chrome.runtime.sendMessage");
  assert.doesNotMatch(page, /window\.open\(/, "Finder must never open a new browser tab/window itself");
});

test("clicking 'Skanuj' (scanFilter) never invokes the collector-bridge/extension-messaging mechanism used by the separate 'validate collector' action", () => {
  const scanFilterBody = page.match(/const scanFilter = async \(filter: SearchFilterListItem\) => \{[\s\S]*?\n  \};/)?.[0];
  assert.ok(scanFilterBody, "scanFilter must exist");
  assert.doesNotMatch(scanFilterBody, /requestCollectorBridgePing|dispatchEvent|CustomEvent/, "Skanuj's own click handler must never dispatch a collector-bridge event or otherwise talk to the extension");
  assert.doesNotMatch(scanFilterBody, /facebook\.com|chrome\.|window\.open\(/, "Skanuj's own click handler must never open a Facebook URL, call a chrome.* API, or open a new window/tab");
  // The one legitimate "Facebook" mention inside scanFilter is a notice
  // about the Watcher's own separate, concurrent background work -- never
  // something this scan itself did (see the dedicated test above proving
  // exactly that notice's real wording).
  assert.match(scanFilterBody, /Facebook Watcher zbiera jeszcze nowe oferty w tle/);
});

// Third Finder/Watcher separation bug, proven via real production read-only
// evidence: filter.lastScan is the most recent source_scans row for this
// filter from ANY origin, including the Watcher's own independent scheduler
// -- a failed Watcher facebook scan rendered here under "Ostatni skan" read
// as if it were Finder's own last action. filter.lastScannedAt is written
// exclusively by Finder's own runManualOtodomScan and can never carry a
// Watcher-owned timestamp.
test("the per-filter row's last-recalculation text reads filter.lastScannedAt (Finder-exclusive), never the Watcher-influenced filter.lastScan", () => {
  assert.doesNotMatch(page, /`Ostatni skan: \$\{formatDateTime\(filter\.lastScan\.startedAt\)\}`/, "the old, Watcher-influenced 'Ostatni skan' text must be gone");
  assert.match(page, /`Ostatnie przeliczenie zapisanych ofert: \$\{formatDateTime\(filter\.lastScannedAt\)\}`/, "the row must use the recalculation-specific label sourced from the Finder-exclusive field");
  assert.match(page, /\{filter\.lastScannedAt\s*\n\s*\? `Ostatnie przeliczenie zapisanych ofert/, "the display must be gated on lastScannedAt, not lastScan");
});
