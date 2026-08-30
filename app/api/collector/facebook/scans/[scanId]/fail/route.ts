import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";
import { createAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ scanId: string }> };

export async function POST(request: Request, { params }: Context) {
  const body = await request.text();
  const { scanId } = await params;
  if (!isUuid(scanId)) return Response.json({ message: "COLLECTOR_SCAN_ID_INVALID" }, { status: 400 });
  try {
    await authenticateSignedCollectorRequest({ request, pathname: `/api/collector/facebook/scans/${scanId}/fail`, body });
    const payload = parsePayload(body);
    const message = payload.error ? `COLLECTOR_SCAN_FAILED: ${payload.error}` : "COLLECTOR_SCAN_FAILED";
    const supabase = createAdminClient();
    const result = await supabase.from("source_scans").update({ status: "failed", finished_at: new Date().toISOString(), error_message: message }).eq("scan_run_id", scanId).eq("source", "facebook").in("status", ["pending", "running"]).select("id");
    if (result.error) return Response.json({ message: "COLLECTOR_SOURCE_SCAN_FAIL_UPDATE_FAILED" }, { status: 503 });
    return Response.json({ scanId, failedSources: result.data?.length ?? 0 });
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : 500;
    return Response.json({ message: error instanceof Error ? error.message : "COLLECTOR_SCAN_FAILED" }, { status });
  }
}

function parsePayload(body: string): { error?: string } {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) && typeof (value as { error?: unknown }).error === "string" ? { error: (value as { error: string }).error.slice(0, 500) } : {};
  } catch {
    return {};
  }
}

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
