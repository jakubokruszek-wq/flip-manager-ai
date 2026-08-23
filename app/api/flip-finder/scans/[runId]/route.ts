import { getScanProgress } from "@/features/flip-finder/server/scan-progress";
import { authenticateApiUser } from "@/lib/supabase/api-auth";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    if (!await authenticateApiUser(request)) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    return Response.json(await getScanProgress((await params).runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "SCAN_STATUS_FAILED";
    return Response.json({ error: message }, { status: message === "SCAN_RUN_NOT_FOUND" ? 404 : message === "INVALID_SCAN_RUN_ID" ? 400 : 500 });
  }
}
