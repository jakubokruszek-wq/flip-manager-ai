import { normalizeFacebookCollectorBatch } from "@/features/collector/facebook-batch";
import { processFacebookCollectorBatch } from "@/features/collector/facebook-batch-server";
import { authenticateSignedCollectorRequest, SignedCollectorAuthError } from "@/features/collector/signed-device-auth";

const PATHNAME = "/api/collector/facebook/batches";

export async function POST(request: Request) {
  const body = await request.text();
  try {
    const { device } = await authenticateSignedCollectorRequest({ request, pathname: PATHNAME, body });
    const batch = normalizeFacebookCollectorBatch(JSON.parse(body));
    const result = await processFacebookCollectorBatch(device.id, batch);
    return cors(Response.json(result, { status: result.status === "duplicate" ? 200 : 202 }), request);
  } catch (error) {
    const status = error instanceof SignedCollectorAuthError ? error.status : error instanceof SyntaxError ? 400 : 422;
    const code = error instanceof SignedCollectorAuthError ? error.code : error instanceof Error ? error.message : "COLLECTOR_BATCH_REJECTED";
    console.error("COLLECTOR BATCH ERROR:", code);
    return cors(Response.json({ code }, { status }), request);
  }
}

export function OPTIONS(request: Request) {
  return cors(new Response(null, { status: 204 }), request);
}

function cors(response: Response, request: Request): Response {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://") || origin?.startsWith("edge-extension://")) response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Vary", "Origin");
  response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Flip-Collector-Device-Id, X-Flip-Collector-Timestamp, X-Flip-Collector-Nonce, X-Flip-Collector-Signature");
  response.headers.set("Cache-Control", "no-store");
  return response;
}
