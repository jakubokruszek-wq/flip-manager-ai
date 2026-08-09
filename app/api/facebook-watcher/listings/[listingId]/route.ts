import { updateFacebookWatcherWorkflow } from "@/features/facebook-watcher/server";
import { FACEBOOK_WORKFLOW_STATUSES, type FacebookWorkflowStatus } from "@/features/facebook-watcher/types";

type Context = { params: Promise<{ listingId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) return Response.json({ error: "Nieprawidłowe dane workflow." }, { status: 400 });
    const status = FACEBOOK_WORKFLOW_STATUSES.includes(body.status as FacebookWorkflowStatus) ? body.status as FacebookWorkflowStatus : undefined;
    const markRead = body.markRead === true;
    const crmPropertyId = typeof body.crmPropertyId === "string" && body.crmPropertyId.trim() ? body.crmPropertyId.trim() : undefined;
    if (!status && !markRead && !crmPropertyId) return Response.json({ error: "Brak zmiany do zapisania." }, { status: 400 });
    await updateFacebookWatcherWorkflow((await params).listingId, { status, markRead, crmPropertyId });
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Nie udało się zaktualizować oferty." }, { status: 500 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
