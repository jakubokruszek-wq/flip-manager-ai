import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { getScanProgress } from "@/features/flip-finder/server/scan-progress";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const url = new URL(request.url);
    const options = url.searchParams.get("observe") === "1" ? { finderFilterId: url.searchParams.get("filterId") ?? "" } : {};
    return Response.json(await getScanProgress((await params).runId, options), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SCAN_STATUS_FAILED";
    return Response.json({ error: message }, { status: message === "SCAN_RUN_NOT_FOUND" ? 404 : message === "INVALID_SCAN_RUN_ID" || message === "INVALID_FILTER_ID" ? 400 : 500 });
  }
}
