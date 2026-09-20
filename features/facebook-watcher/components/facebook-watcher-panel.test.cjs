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
  assert.match(panel, /currentLabel=item\.currentFilterDecision&&item\.currentFilterDecision!==finderStatus\?` · teraz \$\{item\.currentFilterDecision\}`:""/, "the ' · teraz X' suffix must only render when it differs from the Finder status already shown, otherwise 'Finder: REJECTED · teraz REJECTED' repeats the same word");
  assert.doesNotMatch(panel, /text="NOWA"/, "the standalone isNew badge duplicated WorkflowBadge's own 'Nowa' label for the default untouched-listing case and must be removed");
});

// The Watcher embeds the Finder-shared ExpandableListingCard for its rich
// detail dialog. That shared card independently rendered StatusBadge
// ("Aktywna") in TWO places — the collapsed preview AND the expanded dialog
// header — and only the collapsed one was ever gated on variant="watcher"
// (V1.1 blocker 1). Both call sites now route through one exported predicate
// (shouldShowGenericStatusBadge, in listing-card-variant.ts), so they can
// never drift apart again; that predicate is executed and verified directly,
// not by re-checking each site's own independent regex, in
// features/flip-finder/listing-card-variant.test.ts.
test("the Watcher embeds the shared listing card with variant=\"watcher\" and hideLifecycleBadge, and both are wired for every card", () => {
  assert.match(panel, /result=\{result\} variant="watcher"/, "InboxItem must pass variant=\"watcher\" into ExpandableListingCard");
  assert.match(panel, /hideLifecycleBadge=\{presentation\.mode==="unified"\}/, "hideLifecycleBadge must be driven by the real semantic-dedup decision, not a constant");
  assert.match(finderCard, /variant\?: "standalone" \| "watcher"/, "the variant prop must be optional and default-preserving for existing Finder call sites");
  assert.match(finderCard, /props\.variant === "watcher" \? null : <div className="px-5 pb-4 sm:px-8"><GalleryRequestButton/, "GalleryRequestButton must be hidden for the watcher variant so it never competes with the Facebook-specific 'Napraw galerię' repair action");
  assert.match(finderCard, /variant === "watcher" \? null : <Button className="h-11 rounded-xl font-semibold" disabled=\{crmImporting\}/, "the dialog's second, divergent 'Dodaj do CRM' import path must be hidden for the watcher variant, since InboxItem's own action row already has one");
});

// V1.1 blocker 2: the Finder canonical decision and the Watcher lifecycle
// status are two independent signals that can say the same thing (MATCHED +
// ACTIVE) or genuinely disagree (REVIEW + ARCHIVED). resolveListingStatusPresentation
// (tested directly and exhaustively in listing-status-presentation.test.ts)
// decides which; this test only proves the PANEL actually wires that decision
// into both the text line and the embedded card's LifecycleBadge, rather than
// computing its own separate, possibly-inconsistent interpretation.
test("the card's status line and the embedded LifecycleBadge are driven by one resolveListingStatusPresentation call, not two independent guesses", () => {
  assert.match(panel, /const presentation=resolveListingStatusPresentation\(\{finderStatus,lifecycleStatus:facebookLifecycleStatus\(item\.lifecycleStatus\)\}\)/, "the presentation must be computed once, from the same finderStatus used for the ' · teraz X' dedup");
  assert.match(panel, /presentation\.mode==="distinct"\?<>Finder: <strong className="text-foreground">\{presentation\.finderLabel\}<\/strong>\{currentLabel\} · cykl życia: <strong className="text-foreground">\{presentation\.lifecycleLabel\}<\/strong><\/>/, "when they materially differ, both labels must remain visible — disagreement must never be hidden");
  assert.match(panel, /:<>Status: <strong className="text-foreground">\{presentation\.label\}<\/strong>\{currentLabel\}<\/>/, "when they agree, exactly one unified label must be shown");
  assert.match(finderCard, /\{hideLifecycleBadge \? null : <LifecycleBadge status=\{result\.lifecycleStatus\} \/>\}/, "the embedded card's own LifecycleBadge must be suppressible so a 'unified' case doesn't re-introduce the same state a second time");
});

// V1.1 blocker 3: clearWatcherHistory previously checked `historyClearing`
// and only set it AFTER the preview/confirm sequence, so two rapid clicks
// could both start a preview request before either lock existed. The actual
// lock-acquisition-before-first-await and double-click-immunity behavior is
// proven directly, with real overlapping calls, in
// watcher-action-flows.test.ts; this test only proves the panel wires the
// button to that runner instead of reintroducing its own separate guard.
test("Wyczyść historię Watchera delegates its entire lock/preview/confirm/delete sequence to one runner created once", () => {
  assert.match(panel, /const \[historyClearing,setHistoryClearing\]=useState\(false\)/, "clearing must be tracked in its own state, not reused from the per-item busyId");
  assert.match(panel, /disabled=\{historyClearing\}[\s\S]{0,80}onClick=\{\(\)=>void clearWatcherHistory\(\)\}[\s\S]{0,10}>\{historyClearing\?"Czyszczenie…":"Wyczyść historię Watchera"\}/, "the button must disable itself and show a loading label while a clear is in flight");
  assert.match(panel, /const \[runHistoryClear\]=useState\(\(\)=>createHistoryClearRunner\(/, "the runner (and its lock) must be created exactly once per component instance, not recreated on every render");
  assert.match(panel, /\{onBusyChange:setHistoryClearing\}/, "the runner must drive historyClearing itself, so busy state can never desync from whether a clear is actually in flight");
  assert.match(panel, /const clearWatcherHistory=async\(\)=>\{\s*const outcome=await runHistoryClear\(\);/, "clearWatcherHistory must be a thin delegation to the runner");
  assert.doesNotMatch(panel, /if\(historyClearing\)return;/, "the old manual, post-preview guard must be gone — the lock now lives inside the runner, acquired before any await");
  assert.match(panel, /if\(outcome\.kind==="cleared"\)\{setListings\(\[\]\);showToast\("success","Historia Watchera została wyczyszczona\."\);\}/, "a genuinely cleared outcome must refresh the list and show a success toast");
});

// V1.1 blocker 4: the old code patched `images: []` into local state as a
// guess about what the server did, instead of reading back the server's own
// response. runGalleryRepair (tested directly in watcher-action-flows.test.ts)
// now reports exactly the server's own status/jobId; this test proves the
// panel acts on that by refetching authoritative listing data, and that the
// fabricated local patch is gone.
test("Napraw galerię refreshes authoritative server state and never fabricates local gallery state", () => {
  assert.match(panel, /const outcome=await runGalleryRepair\(\{/, "the repair flow's own request/error-mapping logic must live in the tested pure module, not be re-implemented inline");
  assert.doesNotMatch(panel, /images:\[\]/, "the old fabricated local images:[] patch must be gone");
  assert.match(panel, /if\(outcome\.kind==="repaired"\)\{\s*try\{setListings\(await loadListings\(\)\)/, "a successful repair must trigger a real refetch of the Watcher listing dataset (there is no single-listing read endpoint)");
  assert.match(panel, /`Galeria zgłoszona do ponownego pobrania \(status: \$\{outcome\.status\}\)\.`/, "the success message must reflect the server's own reported status (e.g. PENDING), not an invented one");
  assert.match(panel, /Action disabled=\{busy\} label="Napraw galerię" onClick=\{\(\)=>void onRepairGallery\(item\)\}/, "the repair action must still reuse the same per-item busy flag as every other row action");
});

// V1.1 blocker 5: addToCrm used to `await updateWorkflow(...)` — a function
// that caught its own PATCH failure internally and never rethrew — so a
// failed workflow update was followed unconditionally by a success toast.
// The actual impossibility of that false-success sequence is proven directly,
// with a failing workflow update, in watcher-action-flows.test.ts; this test
// proves the panel actually routes addToCrm through that guarded pipeline.
test("addToCrm can never show success after a swallowed workflow-update failure", () => {
  assert.match(panel, /const outcome=await runAddToCrm\(\{/, "addToCrm's own success/failure decision must come from the tested pure runAddToCrm, not a local unconditional continuation");
  assert.match(panel, /updateWorkflow:propertyId=>updateWorkflow\(item,\{status:"crm",crmPropertyId:propertyId\}\)/, "runAddToCrm must be given the SAME updateWorkflow whose result addToCrm ultimately reports — not a call it ignores");
  assert.match(panel, /showToast\(outcome\.kind==="success"\?"success":"error",outcome\.message\)/, "exactly one toast must be shown, chosen by the actual outcome kind, never a toast fired independently of it");
  assert.match(panel, /const result=await runUpdateWorkflow\(\{fetchPatch:/, "updateWorkflow's own PATCH must go through the tested pure runUpdateWorkflow");
  assert.match(panel, /if\(result\.ok\)setListings/, "updateWorkflow must apply its local patch only when the PATCH actually succeeded, never unconditionally");
  assert.match(panel, /return result;\s*\};\s*const guardedUpdateWorkflow=/, "updateWorkflow must return its explicit result so callers (addToCrm, guardedUpdateWorkflow) are forced to check it");
  assert.match(panel, /updateWorkflow=\{guardedUpdateWorkflow\}/, "InboxItem's other fire-and-forget actions (Interesująca/Odrzuć/Przywróć/markRead) must go through the guarded wrapper, which toasts on failure instead of silently swallowing it");
});
