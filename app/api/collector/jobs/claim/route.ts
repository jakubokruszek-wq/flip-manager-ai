import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";
import { claimFacebookJob } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";
const PATHNAME = "/api/collector/jobs/claim";

export async function POST(request: Request) {
  const body = await request.text();
  try {
    const { device } = await authenticateSignedCollectorRequest({ request, pathname: PATHNAME, body, markHealthy: true });
    if (process.env.FACEBOOK_COLLECTOR_QUEUE_ENABLED !== "true") return cors(Response.json({ ok: true, job: null, code: "NO_PENDING_JOB" }), request);
    const job = await claimFacebookJob(device.id);
    return cors(Response.json({ ok: true, job, code: job ? "JOB_CLAIMED" : "NO_PENDING_JOB" }), request);
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : 503;
    return cors(Response.json({ ok: false, code: error instanceof SignedCollectorAuthError ? error.code : "COLLECTOR_JOB_CLAIM_FAILED" }, { status }), request);
  }
}

function cors(response: Response, request: Request) { const origin = request.headers.get("origin"); if (origin?.startsWith("chrome-extension://") || origin?.startsWith("edge-extension://")) response.headers.set("Access-Control-Allow-Origin", origin); response.headers.set("Vary", "Origin"); response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Flip-Collector-Device-Id, X-Flip-Collector-Timestamp, X-Flip-Collector-Nonce, X-Flip-Collector-Signature"); response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS"); return response; }
export function OPTIONS(request: Request) { return cors(new Response(null, { status: 204 }), request); }
