/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const test = require("node:test");
require("./collector-core.js");

const core = globalThis.FlipFacebookCollectorCore;
const EXPECTED_POST_ID = "1597356762082467"; // production regression fixture — see hydrateFacebookGallery() tests
const FOREIGN_POST_ID = "1597344302083713"; // the real neighboring "Projektowanie wnętrz online" post from the same feed window

// 4. set=pcb.<expectedPostId> -> accepted
test("4/positive: an anchor whose set names the exact expected post is accepted with EXACT_PCB_POST_BINDING", () => {
  const evidence = core.evaluateGalleryMediaCandidateEvidence({ setParam: `pcb.${EXPECTED_POST_ID}`, mediaId: "111", expectedPostId: EXPECTED_POST_ID, structuredMediaIds: new Set() });
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.bindingProvenance, "EXACT_PCB_POST_BINDING");
  assert.equal(evidence.reason, "DOM_MEDIA_EXPECTED_PCB");
  assert.equal(evidence.foreignPostId, null);
});

// 2. foreign set=pcb.otherPostId -> rejected (hard evidence, never merely "unverified")
test("2/regression: an anchor whose set names a different post is rejected as foreign, even if it also matches a structured mediaId", () => {
  const evidence = core.evaluateGalleryMediaCandidateEvidence({ setParam: `pcb.${FOREIGN_POST_ID}`, mediaId: "222", expectedPostId: EXPECTED_POST_ID, structuredMediaIds: new Set(["222"]) });
  assert.equal(evidence.accepted, false);
  assert.equal(evidence.bindingProvenance, null);
  assert.equal(evidence.reason, "DOM_MEDIA_FOREIGN_PCB");
  assert.equal(evidence.foreignPostId, FOREIGN_POST_ID);
});

// 5/6. structured exact attachment / DOM mediaId matches an exact structured attachment -> accepted
test("6/positive: a DOM candidate mediaId matching an already-proven structured attachment is accepted with EXACT_STRUCTURED_ATTACHMENT", () => {
  const evidence = core.evaluateGalleryMediaCandidateEvidence({ setParam: null, mediaId: "333", expectedPostId: EXPECTED_POST_ID, structuredMediaIds: new Set(["333", "444"]) });
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.bindingProvenance, "EXACT_STRUCTURED_ATTACHMENT");
  assert.equal(evidence.reason, "DOM_MEDIA_STRUCTURED_MATCH");
});

// 3. missing set + no structured/network proof -> rejected
test("3/regression: a missing set with no structured match is unbound and rejected — DOM proximity alone is never enough", () => {
  const evidence = core.evaluateGalleryMediaCandidateEvidence({ setParam: null, mediaId: "555", expectedPostId: EXPECTED_POST_ID, structuredMediaIds: new Set() });
  assert.equal(evidence.accepted, false);
  assert.equal(evidence.bindingProvenance, null);
  assert.equal(evidence.reason, "DOM_MEDIA_UNBOUND");
});

test("an unrecognized (non-pcb) set with no structured match is also unbound and rejected", () => {
  const evidence = core.evaluateGalleryMediaCandidateEvidence({ setParam: "a.123456789", mediaId: "666", expectedPostId: EXPECTED_POST_ID, structuredMediaIds: new Set() });
  assert.equal(evidence.accepted, false);
  assert.equal(evidence.reason, "DOM_MEDIA_UNBOUND");
});

// Mixed case (mission section): A_MEDIA_1 accepted, B_MEDIA_1 foreign-rejected, C_MEDIA_1 unbound-rejected — proven individually above,
// this test proves they resolve independently when evaluated as a set (order/other-candidates never influence one candidate's evidence).
test("mixed case: pcb-bound, foreign-pcb, and unbound candidates each resolve independently in the same root", () => {
  const structuredMediaIds = new Set();
  const a = core.evaluateGalleryMediaCandidateEvidence({ setParam: `pcb.${EXPECTED_POST_ID}`, mediaId: "A_MEDIA_1", expectedPostId: EXPECTED_POST_ID, structuredMediaIds });
  const b = core.evaluateGalleryMediaCandidateEvidence({ setParam: `pcb.${FOREIGN_POST_ID}`, mediaId: "B_MEDIA_1", expectedPostId: EXPECTED_POST_ID, structuredMediaIds });
  const c = core.evaluateGalleryMediaCandidateEvidence({ setParam: null, mediaId: "C_MEDIA_1", expectedPostId: EXPECTED_POST_ID, structuredMediaIds });
  assert.equal(a.accepted, true);
  assert.equal(b.accepted, false);
  assert.equal(b.reason, "DOM_MEDIA_FOREIGN_PCB");
  assert.equal(c.accepted, false);
  assert.equal(c.reason, "DOM_MEDIA_UNBOUND");
});

test("evaluateViewportMediaDominance threshold is unaffected: the new function accepts a plain Array as well as a Set for structuredMediaIds", () => {
  const evidence = core.evaluateGalleryMediaCandidateEvidence({ setParam: null, mediaId: "777", expectedPostId: EXPECTED_POST_ID, structuredMediaIds: ["777"] });
  assert.equal(evidence.accepted, true);
  assert.equal(evidence.bindingProvenance, "EXACT_STRUCTURED_ATTACHMENT");
});
