import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryClearRunner, runAddToCrm, runGalleryRepair, runUpdateWorkflow, type HistoryClearDeps, type JsonResponse } from "./watcher-action-flows.ts";

const ERROR_MESSAGES = { ACTIVE_FACEBOOK_JOB: "Poczekaj na zakończenie aktywnego skanu lub hydracji Facebooka." };

function historyDeps(overrides: Partial<HistoryClearDeps> = {}): HistoryClearDeps {
  return {
    fetchPreview: async () => ({ ok: true, body: { total: 5, ready: true } }),
    fetchDelete: async () => ({ ok: true, body: {} }),
    confirm: () => true,
    errorMessages: ERROR_MESSAGES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Blocker 3: clear-history double-click race
// ---------------------------------------------------------------------------

test("a rapid double invocation runs the preview/delete sequence exactly once; the second call is a no-op", async () => {
  let previewCalls = 0;
  let deleteCalls = 0;
  let resolvePreview: (value: JsonResponse<{ total?: number; ready?: boolean }>) => void = () => {};
  const previewGate = new Promise<JsonResponse<{ total?: number; ready?: boolean }>>((resolve) => { resolvePreview = resolve; });
  const deps = historyDeps({
    fetchPreview: async () => { previewCalls += 1; return previewGate; },
    fetchDelete: async () => { deleteCalls += 1; return { ok: true, body: {} }; },
  });
  const busyStates: boolean[] = [];
  const run = createHistoryClearRunner(deps, { onBusyChange: (busy) => busyStates.push(busy) });

  const first = run();
  const second = run(); // fired before the first preview request has even resolved
  resolvePreview({ ok: true, body: { total: 5, ready: true } });
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

  assert.equal(previewCalls, 1, "only one preview request may begin");
  assert.equal(deleteCalls, 1, "at most one destructive DELETE request may occur");
  assert.equal(firstOutcome.kind, "cleared");
  assert.deepEqual(secondOutcome, { kind: "already-running" }, "the second call must observe the lock and do nothing");
  assert.deepEqual(busyStates, [true, false], "busy must be signaled exactly once for the whole overlapping pair, not once per call");
});

test("cancelling the confirmation releases the lock cleanly, so a later call can proceed", async () => {
  let confirmCalls = 0;
  // Simulates the user cancelling the first prompt, then clicking again and confirming.
  const deps = historyDeps({ confirm: () => { confirmCalls += 1; return confirmCalls > 1; } });
  const busyStates: boolean[] = [];
  const run = createHistoryClearRunner(deps, { onBusyChange: (busy) => busyStates.push(busy) });

  const cancelled = await run();
  assert.deepEqual(cancelled, { kind: "cancelled" });
  assert.equal(confirmCalls, 1);
  assert.deepEqual(busyStates, [true, false], "the lock must be released even when the user cancels");

  const second = await run();
  assert.equal(second.kind, "cleared", "a later call must be able to proceed normally, proving the lock was actually released");
  assert.equal(confirmCalls, 2);
});

test("a failed preview/status check releases the lock cleanly and reports its own error, distinct from an active-job block", async () => {
  let previewCalls = 0;
  // Simulates a transient network failure on the first check, then a real, successful retry.
  const deps = historyDeps({ fetchPreview: async () => { previewCalls += 1; if (previewCalls === 1) throw new Error("network down"); return { ok: true, body: { total: 5, ready: true } }; } });
  const busyStates: boolean[] = [];
  const run = createHistoryClearRunner(deps, { onBusyChange: (busy) => busyStates.push(busy) });

  const failed = await run();
  assert.equal(failed.kind, "preview-failed");
  assert.deepEqual(busyStates, [true, false], "the lock must be released after a failed status check");

  const second = await run();
  assert.equal(second.kind, "cleared", "the lock must have been released, so a later successful call can proceed");
  assert.equal(previewCalls, 2);
});

test("an active-job block is reported distinctly from a failed preview, using the server's blockedReason", async () => {
  const deps = historyDeps({ fetchPreview: async () => ({ ok: true, body: { total: 3, ready: false, blockedReason: "ACTIVE_FACEBOOK_JOB" } }) });
  const run = createHistoryClearRunner(deps, { onBusyChange: () => {} });
  const outcome = await run();
  assert.deepEqual(outcome, { kind: "blocked", message: ERROR_MESSAGES.ACTIVE_FACEBOOK_JOB });
});

test("a failed DELETE never clears the local list and reports its own distinct outcome", async () => {
  const deps = historyDeps({ fetchDelete: async () => ({ ok: false, body: { code: "FACEBOOK_WATCHER_HISTORY_CLEAR_FAILED" } }) });
  const run = createHistoryClearRunner(deps, { onBusyChange: () => {} });
  const outcome = await run();
  assert.equal(outcome.kind, "delete-failed");
});

// ---------------------------------------------------------------------------
// Blocker 4: gallery repair must reflect authoritative server state, never a
// fabricated local guess.
// ---------------------------------------------------------------------------

test("a successful repair reports the server's own status/jobId, not a fabricated local images:[] patch", async () => {
  const outcome = await runGalleryRepair({
    fetchRepair: async () => ({ ok: true, body: { status: "PENDING", jobId: "job-123" } }),
    errorMessages: {},
  });
  assert.deepEqual(outcome, { kind: "repaired", status: "PENDING", jobId: "job-123" });
});

test("a failed repair never returns a 'repaired' outcome, so the caller can never show a success toast", async () => {
  const outcome = await runGalleryRepair({
    fetchRepair: async () => ({ ok: false, body: { code: "FACEBOOK_GALLERY_REPAIR_ALREADY_RUNNING" } }),
    errorMessages: { FACEBOOK_GALLERY_REPAIR_ALREADY_RUNNING: "Naprawa galerii już trwa dla tej oferty." },
  });
  assert.deepEqual(outcome, { kind: "failed", message: "Naprawa galerii już trwa dla tej oferty." });
});

test("a network-level repair failure is also reported as failed, never fabricated as success", async () => {
  const outcome = await runGalleryRepair({ fetchRepair: async () => { throw new Error("boom"); }, errorMessages: {} });
  assert.equal(outcome.kind, "failed");
});

// ---------------------------------------------------------------------------
// Blocker 5: addToCrm must never report success when the underlying workflow
// PATCH failed.
// ---------------------------------------------------------------------------

test("runUpdateWorkflow returns an explicit failure instead of throwing or swallowing it", async () => {
  const result = await runUpdateWorkflow({ fetchPatch: async () => ({ ok: false, body: { error: "Nie udało się zmienić statusu." } }) });
  assert.deepEqual(result, { ok: false, message: "Nie udało się zmienić statusu." });
});

test("a failed workflow-update PATCH after a successful CRM import yields a failed outcome, never success", async () => {
  let updateWorkflowCalls = 0;
  const outcome = await runAddToCrm({
    fetchImport: async () => ({ ok: true, body: { propertyId: "prop-1", status: "created" } }),
    updateWorkflow: async (propertyId) => { updateWorkflowCalls += 1; assert.equal(propertyId, "prop-1"); return { ok: false, message: "Nie udało się zmienić statusu." }; },
  });
  assert.equal(updateWorkflowCalls, 1);
  assert.deepEqual(outcome, { kind: "failed", message: "Nie udało się zmienić statusu." });
});

test("addToCrm reports success exactly once, and only once both the import and the workflow update genuinely succeeded", async () => {
  const outcome = await runAddToCrm({
    fetchImport: async () => ({ ok: true, body: { propertyId: "prop-2", status: "created" } }),
    updateWorkflow: async () => ({ ok: true }),
  });
  assert.deepEqual(outcome, { kind: "success", message: "Oferta została dodana do CRM." });
});

test("a failed CRM import never reaches the workflow update at all, and is reported as failed", async () => {
  let updateWorkflowCalls = 0;
  const outcome = await runAddToCrm({
    fetchImport: async () => ({ ok: false, body: { message: "Nie udało się dodać oferty do CRM." } }),
    updateWorkflow: async () => { updateWorkflowCalls += 1; return { ok: true }; },
  });
  assert.equal(updateWorkflowCalls, 0, "a failed import must short-circuit before ever touching workflow state");
  assert.deepEqual(outcome, { kind: "failed", message: "Nie udało się dodać oferty do CRM." });
});

test("an already-existing CRM property (status: updated) still requires the workflow update to succeed for a success outcome", async () => {
  const outcome = await runAddToCrm({
    fetchImport: async () => ({ ok: true, body: { propertyId: "prop-3", status: "updated" } }),
    updateWorkflow: async () => ({ ok: true }),
  });
  assert.deepEqual(outcome, { kind: "success", message: "Oferta była już w CRM — rekord został zaktualizowany." });
});
