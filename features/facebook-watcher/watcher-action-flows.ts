/**
 * Pure orchestration for the Watcher panel's multi-step async actions,
 * extracted out of the React component so their control flow (lock
 * acquisition, error propagation, ordering) can be executed and verified
 * directly in tests, independent of any DOM or React rendering.
 */

export type JsonResponse<Body> = { ok: boolean; body: Body };

// ---------------------------------------------------------------------------
// Clear Watcher history
// ---------------------------------------------------------------------------

export type HistoryClearPreviewBody = { total?: number; ready?: boolean; blockedReason?: string | null };
export type HistoryClearDeleteBody = { code?: string };

export type HistoryClearOutcome =
  | { kind: "cleared" }
  | { kind: "cancelled" }
  | { kind: "already-running" }
  | { kind: "blocked"; message: string }
  | { kind: "preview-failed"; message: string }
  | { kind: "delete-failed"; message: string };

export type HistoryClearDeps = {
  fetchPreview: () => Promise<JsonResponse<HistoryClearPreviewBody>>;
  fetchDelete: () => Promise<JsonResponse<HistoryClearDeleteBody>>;
  confirm: (message: string) => boolean;
  errorMessages: Record<string, string>;
};

export type HistoryClearCallbacks = { onBusyChange: (busy: boolean) => void };

const DEFAULT_PREVIEW_FAILED_MESSAGE = "Nie udało się sprawdzić stanu historii Watchera.";
const DEFAULT_BLOCKED_MESSAGE = "Poczekaj na zakończenie aktywnego skanu lub hydracji Facebooka.";
const DEFAULT_DELETE_FAILED_MESSAGE = "Nie udało się wyczyścić historii Watchera.";

/**
 * Creates a runner that acquires its "in progress" lock synchronously, before
 * any await, so a second invocation fired while the first is still in the
 * preview/confirm/delete sequence is a guaranteed no-op ("already-running")
 * rather than a race that can start a second preview or delete request.
 * Call this once per component instance (e.g. from a ref) — the lock lives
 * in this closure, not in React state.
 */
export function createHistoryClearRunner(deps: HistoryClearDeps, callbacks: HistoryClearCallbacks): () => Promise<HistoryClearOutcome> {
  let inFlight = false;
  return async function run(): Promise<HistoryClearOutcome> {
    if (inFlight) return { kind: "already-running" };
    inFlight = true;
    callbacks.onBusyChange(true);
    try {
      let preview: JsonResponse<HistoryClearPreviewBody>;
      try {
        preview = await deps.fetchPreview();
      } catch {
        return { kind: "preview-failed", message: DEFAULT_PREVIEW_FAILED_MESSAGE };
      }
      if (!preview.ok) return { kind: "preview-failed", message: DEFAULT_PREVIEW_FAILED_MESSAGE };
      if (preview.body.ready === false) return { kind: "blocked", message: deps.errorMessages[preview.body.blockedReason ?? ""] ?? DEFAULT_BLOCKED_MESSAGE };
      const confirmed = deps.confirm(`Wyczyścić historię Watchera Facebooka? Usunięte zostaną ${preview.body.total ?? 0} obserwacje; rekordy CRM i powiązania innych źródeł pozostaną zachowane.`);
      if (!confirmed) return { kind: "cancelled" };
      const deleted = await deps.fetchDelete();
      if (!deleted.ok) return { kind: "delete-failed", message: deps.errorMessages[deleted.body.code ?? ""] ?? DEFAULT_DELETE_FAILED_MESSAGE };
      return { kind: "cleared" };
    } finally {
      inFlight = false;
      callbacks.onBusyChange(false);
    }
  };
}

// ---------------------------------------------------------------------------
// Gallery repair
// ---------------------------------------------------------------------------

export type GalleryRepairBody = { code?: string; status?: string; jobId?: string | null };

export type GalleryRepairOutcome =
  | { kind: "repaired"; status: string; jobId: string | null }
  | { kind: "failed"; message: string };

export type GalleryRepairDeps = {
  fetchRepair: () => Promise<JsonResponse<GalleryRepairBody>>;
  errorMessages: Record<string, string>;
};

/**
 * Never fabricates local gallery state (no more optimistic `images: []`).
 * Reports back exactly the status/jobId the repair endpoint itself returned;
 * the caller is expected to refresh authoritative listing data afterwards.
 */
export async function runGalleryRepair(deps: GalleryRepairDeps): Promise<GalleryRepairOutcome> {
  try {
    const response = await deps.fetchRepair();
    if (!response.ok) return { kind: "failed", message: deps.errorMessages[response.body.code ?? ""] ?? "Nie udało się naprawić galerii." };
    return { kind: "repaired", status: response.body.status ?? "PENDING", jobId: response.body.jobId ?? null };
  } catch (reason) {
    return { kind: "failed", message: reason instanceof Error ? reason.message : "Nie udało się naprawić galerii." };
  }
}

// ---------------------------------------------------------------------------
// Workflow update + CRM import
// ---------------------------------------------------------------------------

export type UpdateWorkflowBody = { error?: string };
export type UpdateWorkflowResult = { ok: true } | { ok: false; message: string };

export type UpdateWorkflowDeps = { fetchPatch: () => Promise<JsonResponse<UpdateWorkflowBody>> };

/** Returns an explicit success/failure the caller MUST check — it never throws and never silently swallows a failed PATCH. */
export async function runUpdateWorkflow(deps: UpdateWorkflowDeps): Promise<UpdateWorkflowResult> {
  try {
    const response = await deps.fetchPatch();
    if (!response.ok) return { ok: false, message: response.body.error ?? "Nie udało się zmienić statusu." };
    return { ok: true };
  } catch (reason) {
    return { ok: false, message: reason instanceof Error ? reason.message : "Nie udało się zmienić statusu." };
  }
}

export type AddToCrmImportBody = { propertyId?: unknown; status?: string; message?: string };
export type AddToCrmOutcome = { kind: "success"; message: string } | { kind: "failed"; message: string };

export type AddToCrmDeps = {
  fetchImport: () => Promise<JsonResponse<AddToCrmImportBody>>;
  /** Must be the SAME workflow-update result the UI will act on — this is what makes a false success impossible. */
  updateWorkflow: (propertyId: string) => Promise<UpdateWorkflowResult>;
};

/**
 * A success outcome is only ever returned once BOTH the CRM import request
 * AND the follow-up workflow-status PATCH have genuinely succeeded. A failed
 * workflow PATCH always yields a "failed" outcome — it can never be masked
 * by the import request's own success.
 */
export async function runAddToCrm(deps: AddToCrmDeps): Promise<AddToCrmOutcome> {
  let body: AddToCrmImportBody;
  try {
    const response = await deps.fetchImport();
    body = response.body;
    if (!response.ok || typeof body.propertyId !== "string") return { kind: "failed", message: typeof body.message === "string" ? body.message : "Nie udało się dodać oferty do CRM." };
  } catch (reason) {
    return { kind: "failed", message: reason instanceof Error ? reason.message : "Nie udało się dodać oferty do CRM." };
  }
  const workflowResult = await deps.updateWorkflow(body.propertyId as string);
  if (!workflowResult.ok) return { kind: "failed", message: workflowResult.message };
  return { kind: "success", message: body.status === "updated" ? "Oferta była już w CRM — rekord został zaktualizowany." : "Oferta została dodana do CRM." };
}
