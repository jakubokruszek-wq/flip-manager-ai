import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { analyzeFacebookImages } from "@/features/facebook-watcher/analyze-facebook-images";
import { createFacebookWatcherAdminClient } from "@/features/facebook-watcher/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = parsePayload(JSON.parse(auth.body) as unknown);
    const supabase = createFacebookWatcherAdminClient();
    const lease = await supabase.from("facebook_scan_jobs").select("id").eq("id", input.jobId).eq("lease_token", input.leaseToken).eq("worker_id", input.workerId).eq("status", "running").maybeSingle();
    if (lease.error || !lease.data) return Response.json({ error: "FACEBOOK_JOB_LEASE_LOST" }, { status: 409 });
    const vision = await analyzeFacebookImages([input.screenshotDataUrl, ...input.imageUrls], undefined, { contextImageCount: 1 });
    if (!vision) return Response.json({ error: "FACEBOOK_VISION_UNAVAILABLE" }, { status: 503 });
    return Response.json({ vision });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_VISION_FAILED" }, { status: 422 });
  }
}

function parsePayload(value: unknown): { jobId: string; leaseToken: string; workerId: string; postId: string; screenshotDataUrl: string; imageUrls: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PAYLOAD");
  const row = value as Record<string, unknown>;
  const jobId = requiredString(row.jobId, 100); const leaseToken = requiredString(row.leaseToken, 100); const workerId = requiredString(row.workerId, 100); const postId = requiredString(row.postId, 300); const screenshotDataUrl = requiredString(row.screenshotDataUrl, 950_000);
  if (!/^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(screenshotDataUrl)) throw new Error("INVALID_FACEBOOK_POST_SCREENSHOT");
  if (!Array.isArray(row.imageUrls) || row.imageUrls.length > 5) throw new Error("INVALID_FACEBOOK_IMAGE_URLS");
  const imageUrls = row.imageUrls.map((value) => {
    if (typeof value !== "string" || value.length > 2_000) throw new Error("INVALID_FACEBOOK_IMAGE_URLS");
    const url = new URL(value); if (url.protocol !== "https:") throw new Error("INVALID_FACEBOOK_IMAGE_URLS"); return url.toString();
  });
  return { jobId, leaseToken, workerId, postId, screenshotDataUrl, imageUrls };
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("INVALID_PAYLOAD");
  return value.trim();
}
