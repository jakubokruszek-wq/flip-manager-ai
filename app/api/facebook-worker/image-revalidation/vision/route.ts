import { authenticateFacebookWorkerRequest } from "@/features/facebook-worker/auth";
import { analyzeFacebookImages } from "@/features/facebook-watcher/analyze-facebook-images";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await authenticateFacebookWorkerRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = parseInput(JSON.parse(auth.body) as unknown);
    const vision = await analyzeFacebookImages([input.screenshotDataUrl, ...input.imageUrls], undefined, { contextImageCount: 1 });
    if (!vision) return Response.json({ error: "FACEBOOK_VISION_UNAVAILABLE" }, { status: 503 });
    console.info("FACEBOOK_IMAGE_REVALIDATION_VISION", { postId: input.postId, model: vision.usage.model, calls: 1, dataQuality: vision.usage.dataQuality });
    return Response.json({ vision });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "FACEBOOK_REVALIDATION_VISION_FAILED" }, { status: 422 });
  }
}

function parseInput(value: unknown): { postId: string; screenshotDataUrl: string; imageUrls: string[] } {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const postId = requiredString(row.postId, 300);
  const screenshotDataUrl = requiredString(row.screenshotDataUrl, 950_000);
  if (!/^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(screenshotDataUrl)) throw new Error("INVALID_FACEBOOK_POST_SCREENSHOT");
  if (!Array.isArray(row.imageUrls) || row.imageUrls.length > 5) throw new Error("INVALID_FACEBOOK_IMAGE_URLS");
  const imageUrls = row.imageUrls.map((value) => { const url = new URL(requiredString(value, 2_000)); if (url.protocol !== "https:") throw new Error("INVALID_FACEBOOK_IMAGE_URLS"); return url.toString(); });
  return { postId, screenshotDataUrl, imageUrls };
}
function requiredString(value: unknown, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("INVALID_PAYLOAD"); return value.trim(); }
