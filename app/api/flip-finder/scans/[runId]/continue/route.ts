import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { runFinderScanPortion } from "@/features/flip-finder/server/manual-scan";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ runId: string }> };

export async function POST(_request: Request, { params }: Context) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    // Await the bounded portion: a disconnected client does not undo its
    // durable checkpoint. A later poll/cron can continue the same run.
    return Response.json(await runFinderScanPortion((await params).runId));
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "SCAN_CONTINUATION_FAILED" }, { status: error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 500 });
  }
}
