/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const panel = fs.readFileSync(path.join(__dirname, "facebook-watcher-panel.tsx"), "utf8");
const inbox = fs.readFileSync(path.join(__dirname, "../facebook-inbox.ts"), "utf8");
const finderCard = fs.readFileSync(path.join(__dirname, "../../flip-finder/components/inline-filter-results.tsx"), "utf8");

// Deep sort correctness (all 6 modes + the deterministic tie-break chain) is
// proven behaviorally, with the real exported sortFacebookInbox, in
// facebook-inbox.test.ts and facebook-inbox-tiebreak.test.ts. This file's job
// is the piece those tests cannot cover: proving the RENDERED PANEL actually
// wires its dropdown to that function and renders its result, in order,
// rather than some other (possibly stale) list.
test("the sort dropdown, sortFacebookInbox, and rendered items are the same pipeline", () => {
  assert.match(panel, /const \[sort,setSort\]=useState<FacebookInboxSort>\("newest"\)/, "sort must be real component state, not a constant");
  assert.match(panel, /const visible=useMemo\(\(\)=>sortFacebookInbox\(filterFacebookInbox\(listings,tab,filters\),sort\),\[filters,listings,sort,tab\]\)/, "visible must be computed by piping the filtered list through sortFacebookInbox with the live sort state, and the memo must depend on `sort`");
  assert.match(panel, /<select aria-label="Sortowanie"[^>]*value=\{sort\} onChange=\{event=>setSort\(event\.target\.value as FacebookInboxSort\)\}>/, "the dropdown must be a controlled input whose onChange writes directly into the sort state");
  assert.match(panel, /\{visible\.map\(item=><InboxItem /, "the rendered list must map over `visible` (the sorted result), not the raw `listings`");
  assert.doesNotMatch(panel, /\{listings\.map\(item=><InboxItem /, "rendering must never bypass sortFacebookInbox by mapping the unsorted listings directly");
});

test("every FacebookInboxSort option the dropdown offers exists in the type, and every type value has a dropdown option", () => {
  const typeMatch = inbox.match(/export type FacebookInboxSort = ("(?:[a-z_]+")(?:\s*\|\s*"[a-z_]+")*)/);
  assert.ok(typeMatch, "FacebookInboxSort union must be found in facebook-inbox.ts");
  const typeValues = [...typeMatch[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual(typeValues, ["newest", "opportunity", "flip", "price_per_sqm", "price", "profit"]);
  // Scoped to the sort <select> specifically, so an unrelated dropdown's
  // (e.g. seller type, condition) option values can never leak into this check.
  const start = panel.indexOf('aria-label="Sortowanie"');
  assert.ok(start >= 0, "the sort dropdown must exist");
  const dropdownSection = panel.slice(start, panel.indexOf("</select>", start));
  const optionValues = [...dropdownSection.matchAll(/<option value="([a-z_]+)">/g)].map((match) => match[1]);
  assert.deepEqual([...optionValues].sort(), [...typeValues].sort(), "the dropdown's <option> values and the FacebookInboxSort union must match exactly, in both directions");
});

// UI cleanup v1: the page previously rendered three separate KPI rows —
// "Cykl życia" (the 5 target tiles), "Spójność Finder Watcher" (which
// duplicated "W bazie" 1:1 via a "Watcher" tile, since visibilityInWatcher is
// hardcoded true for every listing), and "Liczniki Inboxu" (which duplicated
// "Nowe dziś" from the first row and the tab nav's own per-status counts).
test("the page has exactly one primary KPI section, no duplicated 'Watcher' tile, and 'Nowe dziś' rendered once", () => {
  const sectionLabels = [...panel.matchAll(/<section aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sectionLabels, ["Cykl życia ofert Facebook"], "only the lifecycle KPI row may be a top-level aria-labelled <section>; the old 'Spójność Finder Watcher' and 'Liczniki Inboxu' sections must be gone");
  assert.doesNotMatch(panel, /Liczniki Inboxu/, "the secondary counters row duplicating the tab nav's own counts must be removed");
  assert.doesNotMatch(panel, /Najlepsze okazje z Facebooka/, "the TOP-10 carousel duplicated the main sortable result grid (sort=opportunity already covers it) and must be removed, leaving one clear result area");
  assert.equal((panel.match(/label="Nowe dziś"/g) ?? []).length, 1, "'Nowe dziś' must appear in exactly one KPI tile, not two");
  assert.equal((panel.match(/<Counter label="Watcher"/g) ?? []).length, 0, "the 'Watcher' tile must not be rendered: it always equals lifecycle.database (every listing has visibilityInWatcher:true), making it a pure duplicate of 'W bazie'");
});

test("Finder/Watcher consistency diagnostics are demoted to a collapsed secondary area, not the primary KPI row", () => {
  assert.match(panel, /<details className="[^"]*"><summary[^>]*>Diagnostyka spójności Finder \/ Watcher<\/summary>/, "MATCHED/REVIEW/REJECTED/HISTORICAL must live in a collapsed <details> diagnostics panel");
  assert.match(panel, /<Counter label="MATCHED" value=\{consistency\.matched\}\/><Counter label="REVIEW" value=\{consistency\.review\}\/><Counter label="REJECTED" value=\{consistency\.rejected\}\/><Counter label="HISTORICAL" value=\{consistency\.historical\}\/>/, "the diagnostics panel keeps exactly the 4 non-duplicated breakdown counters");
});

// The old code built `Finder: ${item.finderStatus} · teraz ${item.currentFilterDecision}`
// unconditionally, so a listing whose finderStatus and currentFilterDecision
// were both e.g. "REJECTED" rendered the literal "Finder: REJECTED · teraz
// REJECTED". The standalone isNew "NOWA" badge duplicated the WorkflowBadge's
// own "Nowa" label for the common case of an untouched, freshly-imported item.
test("the card never repeats the same status word twice: the Finder/current-decision line is deduped and the redundant isNew badge is removed", () => {
  assert.match(panel, /currentLabel=item\.currentFilterDecision&&item\.currentFilterDecision!==finderLabel\?` · teraz \$\{item\.currentFilterDecision\}`:""/, "the ' · teraz X' suffix must only render when it differs from the Finder label already shown, otherwise 'Finder: REJECTED · teraz REJECTED' repeats the same word");
  assert.doesNotMatch(panel, /text="NOWA"/, "the standalone isNew badge duplicated WorkflowBadge's own 'Nowa' label for the default untouched-listing case and must be removed");
});

// The Watcher embeds the Finder-shared ExpandableListingCard for its rich
// detail dialog. That shared card independently rendered StatusBadge
// ("Aktywna") and LifecycleBadge ("AKTYWNA" — its own fallback label) at once
// for any normal active listing, plus its own isNew "Nowa" ribbon and a
// second, divergent "Dodaj do CRM" import path, and an always-eligible
// GalleryRequestButton hitting a different endpoint than "Napraw galerię".
// variant="watcher" suppresses exactly those duplicates without changing any
// default (Finder) behavior.
test("the Watcher embeds the shared listing card with variant=\"watcher\", which suppresses its duplicate status badge, CRM button, and gallery-request button", () => {
  assert.match(panel, /result=\{result\} variant="watcher"/, "InboxItem must pass variant=\"watcher\" into ExpandableListingCard");
  assert.match(finderCard, /variant\?: "standalone" \| "watcher"/, "the variant prop must be optional and default-preserving for existing Finder call sites");
  assert.match(finderCard, /variant === "watcher" \? null : <StatusBadge/, "StatusBadge (\"Aktywna\") must be suppressed for the watcher variant, leaving LifecycleBadge as the single lifecycle indicator");
  assert.match(finderCard, /variant === "watcher" \? null : <Button className="h-11 rounded-xl font-semibold" disabled=\{crmImporting\}/, "the dialog's second, divergent 'Dodaj do CRM' import path must be hidden for the watcher variant, since InboxItem's own action row already has one");
  assert.match(finderCard, /props\.variant === "watcher" \? null : <div className="px-5 pb-4 sm:px-8"><GalleryRequestButton/, "GalleryRequestButton must be hidden for the watcher variant so it never competes with the Facebook-specific 'Napraw galerię' repair action");
});

// clearWatcherHistory previously threw one identical message for both a failed
// preview fetch (network/server error) and an active-job block, and had no
// loading/disabled state, letting a user fire multiple concurrent DELETEs.
test("Wyczyść historię Watchera has a loading/disabled state and distinguishes a failed status check from an active-job block", () => {
  assert.match(panel, /const \[historyClearing,setHistoryClearing\]=useState\(false\)/, "clearing must be tracked in its own state, not reused from the per-item busyId");
  assert.match(panel, /disabled=\{historyClearing\}[\s\S]{0,80}onClick=\{\(\)=>void clearWatcherHistory\(\)\}[\s\S]{0,10}>\{historyClearing\?"Czyszczenie…":"Wyczyść historię Watchera"\}/, "the button must disable itself and show a loading label while a clear is in flight");
  assert.match(panel, /if\(historyClearing\)return;/, "a second click while already clearing must be a no-op");
  assert.match(panel, /if\(!preview\.ok\)throw new Error\("Nie udało się sprawdzić stanu historii Watchera\."\)/, "a failed status check must surface its own message");
  assert.match(panel, /if\(summary\.ready===false\)\{showToast\("error",HISTORY_CLEAR_ERROR_MESSAGES\[summary\.blockedReason\?\?""\]/, "an active-job block must surface a distinct message from a failed status check, using the server's own blockedReason");
  assert.match(panel, /setListings\(\[\]\);showToast\("success","Historia Watchera została wyczyszczona\."\)/, "a successful clear must refresh the list and show a success toast");
});

test("Napraw galerię surfaces known server error codes as friendly toasts and stays disabled while in flight", () => {
  assert.match(panel, /GALLERY_REPAIR_ERROR_MESSAGES\[body\.code\?\?""\]\?\?"Nie udało się naprawić galerii\."/, "known gallery-repair error codes must map to a friendly message, falling back to a generic one for unknown codes");
  assert.match(panel, /showToast\("success","Galeria została wyzerowana i dodano jedno zadanie hydracji\."\)/, "a successful repair must show a success toast");
  assert.match(panel, /Action disabled=\{busy\} label="Napraw galerię" onClick=\{\(\)=>void onRepairGallery\(item\)\}/, "the repair action must reuse the same per-item busy flag as every other row action, disabling it while a request for that listing is in flight");
});
