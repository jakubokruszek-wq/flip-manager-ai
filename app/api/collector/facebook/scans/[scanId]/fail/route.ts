import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";
import { collectorScanFailurePatch, parseCollectorScanFailure } from "@/features/collector/facebook-scan-failure";
import { createAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ scanId: string }> };

export async function POST(request: Request, { params }: Context) {
  const body = await request.text();
  const { scanId } = await params;
  if (!isUuid(scanId)) return Response.json({ message: "COLLECTOR_SCAN_ID_INVALID" }, { status: 400 });
  try {
    await authenticateSignedCollectorRequest({ request, pathname: `/api/collector/facebook/scans/${scanId}/fail`, body });
    const payload = parseCollectorScanFailure(body);
    const supabase = createAdminClient();
    const sources = await supabase.from("source_scans").select("id,warnings,diagnostics").eq("scan_run_id", scanId).eq("source", "facebook").in("status", ["pending", "running"]);
    if (sources.error) return Response.json({ message: "COLLECTOR_SOURCE_SCAN_FAIL_LOOKUP_FAILED" }, { status: 503 });
    const now = new Date().toISOString();
    const updates = await Promise.all((sources.data ?? []).map((source) => supabase.from("source_scans").update(collectorScanFailurePatch(payload, source, now)).eq("id", source.id).in("status", ["pending", "running"]).select("id")));
    if (updates.some((result) => result.error)) return Response.json({ message: "COLLECTOR_SOURCE_SCAN_FAIL_UPDATE_FAILED" }, { status: 503 });
    return Response.json({ scanId, failedSources: updates.reduce((total, result) => total + (result.data?.length ?? 0), 0), errorCode: payload.errorCode });
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : 500;
    return Response.json({ message: error instanceof Error ? error.message : "COLLECTOR_SCAN_FAILED" }, { status });
  }
}

function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
