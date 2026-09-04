import { getFacebookSchedulerDiagnostics } from "@/features/facebook-worker/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json(await getFacebookSchedulerDiagnostics(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "SCHEDULER_DIAGNOSTICS_FAILED" }, { status: 503 });
  }
}
