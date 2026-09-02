import { readCollectorReadiness } from "@/features/collector/facebook-dispatch";
import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";

const PATHNAME = "/api/collector/readiness";

export async function POST(request: Request) {
  const body = await request.text();
  try {
    const { device } = await authenticateSignedCollectorRequest({ request, pathname: PATHNAME, body, markHealthy: true });
    const readiness = await readCollectorReadiness(Date.now(), device.id);
    return cors(Response.json({ ok: readiness.ready, ready: readiness.ready, deviceId: device.id, lastHeartbeatAt: readiness.lastHeartbeatAt, health: readiness.health, reason: readiness.reason }), request);
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : 503;
    const code = error instanceof SignedCollectorAuthError ? error.code : "COLLECTOR_READINESS_UNAVAILABLE";
    return cors(Response.json({ ok: false, ready: false, code }, { status }), request);
  }
}

export function OPTIONS(request: Request) { return cors(new Response(null, { status: 204 }), request); }

function cors(response: Response, request: Request) {
  const origin = request.headers.get("origin");
  if (origin && (/^chrome-extension:\/\/[a-z]{32}$/.test(origin) || /^edge-extension:\/\/[a-z]{32}$/.test(origin))) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Flip-Collector-Device-Id, X-Flip-Collector-Timestamp, X-Flip-Collector-Nonce, X-Flip-Collector-Signature");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
