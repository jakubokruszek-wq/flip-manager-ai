import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { getFacebookPostCache } from "@/features/facebook-worker/jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = parsePayload(JSON.parse(auth.body) as unknown);
    return Response.json({ hits: await getFacebookPostCache(input) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_CACHE_LOOKUP_FAILED" }, { status: 409 });
  }
}

function parsePayload(value: unknown): { jobId: string; leaseToken: string; workerId: string; postIds: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  const row = value as Record<string, unknown>;
  const required = (field: string) => {
    const item = row[field];
    if (typeof item !== "string" || !item.trim() || item.length > 100) throw new Error("INVALID_PAYLOAD");
    return item.trim();
  };
  if (!Array.isArray(row.postIds) || row.postIds.length > 50 || row.postIds.some((id) => typeof id !== "string" || !/^\d+$/.test(id) || id.length > 300)) throw new Error("INVALID_POST_IDS");
  return { jobId: required("jobId"), leaseToken: required("leaseToken"), workerId: required("workerId"), postIds: [...new Set(row.postIds as string[])] };
}
