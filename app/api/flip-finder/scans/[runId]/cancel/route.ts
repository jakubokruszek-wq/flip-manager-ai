import { cancelScanRun } from "@/features/flip-finder/server/cancel-scan";

type Context = { params: Promise<{ runId: string }> };

export async function POST(_request: Request, { params }: Context) {
  try {
    return Response.json(await cancelScanRun((await params).runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nie udało się zatrzymać skanu.";
    return Response.json({ message }, { status: message === "INVALID_SCAN_RUN_ID" ? 400 : 502 });
  }
}
