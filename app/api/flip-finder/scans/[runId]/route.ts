import { getScanProgress } from "@/features/flip-finder/server/scan-progress";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const supabase = await createClient();
    let { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
      const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
      if (token) ({ data: { user }, error } = await supabase.auth.getUser(token));
    }
    if (error || !user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    return Response.json(await getScanProgress((await params).runId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "SCAN_STATUS_FAILED";
    return Response.json({ error: message }, { status: message === "SCAN_RUN_NOT_FOUND" ? 404 : message === "INVALID_SCAN_RUN_ID" ? 400 : 500 });
  }
}
