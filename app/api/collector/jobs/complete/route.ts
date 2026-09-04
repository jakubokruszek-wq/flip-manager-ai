import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";
import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";
import { runFacebookSchedulerTick } from "@/features/facebook-worker/scheduler";

const PATHNAME = "/api/collector/jobs/complete";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await request.text();
  try {
    const { device } = await authenticateSignedCollectorRequest({ request, pathname: PATHNAME, body, markHealthy: true });
    const input = JSON.parse(body) as { jobId?: string; leaseToken?: string; status?: string; errorCode?: string | null };
    if (!input.jobId || !input.leaseToken || !["completed", "failed"].includes(String(input.status))) return Response.json({ ok: false, code: "INVALID_PAYLOAD" }, { status: 400 });
    const supabase = createFacebookWatcherAdminClient();
    const now = new Date().toISOString();
    const update = await supabase.from("facebook_scan_jobs").update({ status: input.status, finished_at: now, leased_until: null, heartbeat_at: now, error_code: input.status === "failed" ? String(input.errorCode || "COLLECTOR_FAILED").slice(0, 100) : null, error_message: input.status === "failed" ? String(input.errorCode || "Collector failed").slice(0, 1_000) : null }).eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", device.id).eq("status", "running").select("id").maybeSingle();
    if (update.error || !update.data) return Response.json({ ok: false, code: "COLLECTOR_JOB_LEASE_LOST" }, { status: 409 });
    await runFacebookSchedulerTick();
    return cors(Response.json({ ok: true, status: input.status }), request);
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : 503;
    return cors(Response.json({ ok: false, code: error instanceof SignedCollectorAuthError ? error.code : "COLLECTOR_JOB_COMPLETE_FAILED" }, { status }), request);
  }
}

function cors(response: Response, request: Request) { const origin = request.headers.get("origin"); if (origin?.startsWith("chrome-extension://") || origin?.startsWith("edge-extension://")) response.headers.set("Access-Control-Allow-Origin", origin); response.headers.set("Vary", "Origin"); response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Flip-Collector-Device-Id, X-Flip-Collector-Timestamp, X-Flip-Collector-Nonce, X-Flip-Collector-Signature"); response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS"); return response; }
export function OPTIONS(request: Request) { return cors(new Response(null, { status: 204 }), request); }
