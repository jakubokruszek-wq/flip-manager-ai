import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";
import { FacebookLeaseRenewalError, renewFacebookExtensionJobLease } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";
const PATHNAME = "/api/collector/jobs/heartbeat";

export async function POST(request: Request) {
  const body = await request.text();
  try {
    const { device } = await authenticateSignedCollectorRequest({ request, pathname: PATHNAME, body, markHealthy: true });
    const input = JSON.parse(body) as { jobId?: string; leaseToken?: string };
    if (!input.jobId || !input.leaseToken) return cors(Response.json({ ok: false, code: "INVALID_PAYLOAD" }, { status: 400 }), request);
    const leasedUntil = await renewFacebookExtensionJobLease({ jobId: input.jobId, leaseToken: input.leaseToken, workerId: device.id });
    return cors(Response.json({ ok: true, leasedUntil }), request);
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : 409;
    const code = error instanceof SignedCollectorAuthError ? error.code : error instanceof FacebookLeaseRenewalError ? error.code : "FACEBOOK_JOB_LEASE_RENEW_FAILED";
    const diagnostics = error instanceof FacebookLeaseRenewalError ? error.diagnostics : null;
    if (diagnostics) console.warn("FACEBOOK_JOB_LEASE_RENEW_REJECTED", diagnostics);
    return cors(Response.json({ ok: false, code, diagnostics }, { status }), request);
  }
}

function cors(response: Response, request: Request) {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://") || origin?.startsWith("edge-extension://")) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Flip-Collector-Device-Id, X-Flip-Collector-Timestamp, X-Flip-Collector-Nonce, X-Flip-Collector-Signature");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return response;
}

export function OPTIONS(request: Request) { return cors(new Response(null, { status: 204 }), request); }
