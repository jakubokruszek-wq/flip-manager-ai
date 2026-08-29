import { getScanProgress } from "@/features/flip-finder/server/scan-progress";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context) {
  void request;
  try {
    return Response.json(await getScanProgress((await params).runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "SCAN_STATUS_FAILED";
    return Response.json({ error: message }, { status: message === "SCAN_RUN_NOT_FOUND" ? 404 : message === "INVALID_SCAN_RUN_ID" ? 400 : 500 });
  }
}
