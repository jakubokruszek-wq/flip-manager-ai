import { getListingLifecycleDryRun, runListingLifecycleBatch } from "@/features/listing-lifecycle/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const probeLimit = Math.max(0, Math.min(Number(url.searchParams.get("probe") ?? 0) || 0, 20));
  return Response.json(await getListingLifecycleDryRun(probeLimit));
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await runListingLifecycleBatch());
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? request.headers.get("x-cron-secret");
  return supplied === secret;
}
