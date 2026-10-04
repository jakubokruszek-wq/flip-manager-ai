import { runFinderScanContinuations } from "@/features/flip-finder/server/manual-scan";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Durable hourly trigger for Finder source rows left pending by a bounded
 * serverless invocation. The route is intentionally cron-secret protected;
 * it never starts a user-facing scan and never touches OLX's separate queue.
 */
export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}

async function run(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runFinderScanContinuations();
    return Response.json(result, { status: result.status === "schema_unavailable" ? 503 : 200 });
  } catch (error) {
    console.error("FINDER SCAN CONTINUATION FAILED:", error);
    return Response.json({ error: "Continuation failed" }, { status: 500 });
  }
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-cron-secret");
  return supplied === secret;
}
