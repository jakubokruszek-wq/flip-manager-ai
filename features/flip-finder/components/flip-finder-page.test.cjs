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
const galleryAuth = fs.readFileSync(path.join(__dirname, "../server/gallery-request-auth.ts"), "utf8");

test("normal Flip Finder UI uses the queue scan result funnel", () => {
  assert.match(page, /WYNIK OSTATNIEGO SKANU/);
  assert.match(page, /Zebrane posty/);
  assert.match(page, /Zweryfikowane EXACT/);
  assert.match(page, /SELL_PROPERTY/);
  assert.match(page, /ODRZUCONE/);
  assert.match(page, /Nowe zapisane oferty/);
  assert.match(page, /Zaktualizowane/);
  assert.match(page, /Ten skan nie dodał nowych ofert\.|Nie zapisano ofert\./);
  assert.match(page, /Szczegóły diagnostyczne/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void validateCollector\(activeFilter\)\}/);
  assert.doesNotMatch(page, /onClick=\{\(\) => void testDirectExternalChannel\(\)\}/);
  assert.doesNotMatch(page, /\{collectorValidation \? <CollectorValidationPanel/);
  assert.doesNotMatch(page, /\{externalPingResult \? <div/);
});

test("saved listings database is labeled independently from the latest scan", () => {
  assert.match(inlineResults, /BAZA OFERT/);
  assert.match(inlineResults, /Aktywne zapisane oferty:/);
  assert.doesNotMatch(inlineResults, /Znalezione oferty:/);
});

test("archive is opt-in and fetched separately from the main finder", () => {
  assert.match(inlineResults, /Pokaż archiwum/);
  assert.match(inlineResults, /view=archive/);
  assert.match(inlineResults, /archiveOpen \? \(data\?\.archivedResults/);
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

test("gallery mutation is protected by same-origin request authorization", () => {
  assert.match(galleryRoute, /authorizeGalleryMutation/);
  assert.match(inlineResults, /x-flip-finder-action.*gallery/);
  assert.match(galleryAuth, /GALLERY_REQUEST_FORBIDDEN/);
  assert.match(galleryAuth, /https:\/\/flip-manager-ai\.vercel\.app/);
  assert.match(galleryTraceRoute, /authorizeGalleryTrace/);
  assert.match(galleryTraceRoute, /FLIP_GALLERY_SERVER_TRACE/);
  assert.match(galleryTraceRoute, /GALLERY_TRACE_TOO_LARGE/);
  assert.match(galleryTraceStore, /GALLERY_BUTTON_POINTER_CAPTURE/);
  assert.match(galleryTraceStore, /GALLERY_CARD_POINTER_CAPTURE/);
  assert.match(galleryTraceStore, /GALLERY_BUTTON_CLICK_CAPTURE/);
  assert.match(galleryTraceStore, /GALLERY_CARD_CLICK_CAPTURE/);
  assert.match(galleryTraceRoute, /readGalleryTraces/);
  assert.match(galleryTraceRoute, /writeGalleryTrace/);
  assert.match(galleryTraceRoute, /authorizeGalleryTraceRead/);
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
