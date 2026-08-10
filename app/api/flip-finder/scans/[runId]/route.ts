import { getOlxScanRunStatus } from "@/features/flip-finder/server/olx-jobs";

type Context = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    return Response.json(await getOlxScanRunStatus((await params).runId));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "SCAN_STATUS_FAILED" }, { status: 500 });
  }
}
