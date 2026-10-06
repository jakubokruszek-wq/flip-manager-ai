import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { getLatestFinderRun } from "@/features/flip-finder/server/latest-finder-run";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    return Response.json(await getLatestFinderRun((await params).id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FINDER_RUN_READ_FAILED";
    return Response.json({ error: message }, { status: message === "INVALID_FILTER_ID" ? 400 : 500 });
  }
}
