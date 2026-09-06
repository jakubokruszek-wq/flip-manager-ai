import { enqueueFacebookGalleryJob, getFacebookGalleryStatus } from "@/features/facebook-worker/gallery-jobs";
import { authorizeGalleryMutation } from "@/features/flip-finder/server/gallery-request-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const listingId = (await params).id;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  try {
    return Response.json({ ok: true, ...(await getFacebookGalleryStatus(listingId)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FACEBOOK_GALLERY_STATUS_FAILED";
    return Response.json({ ok: false, code: message === "FACEBOOK_GALLERY_LISTING_NOT_FOUND" ? message : "FACEBOOK_GALLERY_STATUS_FAILED" }, { status: message === "FACEBOOK_GALLERY_LISTING_NOT_FOUND" ? 404 : 503 });
  }
}

export async function POST(_request: Request, { params }: Context): Promise<Response> {
  const authorizationError = authorizeGalleryMutation(_request);
  if (authorizationError) return authorizationError;
  const listingId = (await params).id;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  try {
    const result = await enqueueFacebookGalleryJob(listingId);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FACEBOOK_GALLERY_REQUEST_FAILED";
    const known = ["FACEBOOK_GALLERY_LISTING_NOT_FOUND", "FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE", "FACEBOOK_GALLERY_EXACT_POST_REQUIRED", "FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING"];
    return Response.json({ ok: false, code: known.includes(message) ? message : "FACEBOOK_GALLERY_REQUEST_FAILED" }, { status: known.includes(message) ? 400 : 503 });
  }
}
