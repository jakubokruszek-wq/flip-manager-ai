import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { repairFacebookGalleryJob } from "@/features/facebook-worker/gallery-jobs";

type Context = { params: Promise<{ listingId: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  const listingId = (await params).listingId;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  try { return Response.json({ ok: true, ...(await repairFacebookGalleryJob(listingId)) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : "FACEBOOK_GALLERY_REPAIR_FAILED";
    const code = message.split(":", 1)[0];
    const known = ["FACEBOOK_GALLERY_LISTING_NOT_FOUND", "FACEBOOK_GALLERY_LISTING_NOT_ELIGIBLE", "FACEBOOK_GALLERY_EXACT_POST_REQUIRED", "FACEBOOK_GALLERY_FILTER_CONTEXT_MISSING", "FACEBOOK_GALLERY_REPAIR_ALREADY_RUNNING", "FACEBOOK_GALLERY_METADATA_IDENTITY_AMBIGUOUS", "FACEBOOK_GALLERY_METADATA_GROUP_MISMATCH"];
    return Response.json({ ok: false, code: known.includes(code) ? code : "FACEBOOK_GALLERY_REPAIR_FAILED" }, { status: known.includes(code) ? 409 : 503 });
  }
}
