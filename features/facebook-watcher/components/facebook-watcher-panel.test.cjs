/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const panel = fs.readFileSync(path.join(__dirname, "facebook-watcher-panel.tsx"), "utf8");
const inbox = fs.readFileSync(path.join(__dirname, "../facebook-inbox.ts"), "utf8");

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
