import { authorizeGalleryTrace } from "@/features/flip-finder/server/gallery-request-auth";

type Context = { params: Promise<{ id: string }> };

const STAGES = new Set([
  "GALLERY_UI_CLICK",
  "GALLERY_HANDLER_ENTER",
  "GALLERY_GUARD_PASS",
  "GALLERY_GUARD_BLOCKED",
  "GALLERY_FETCH_START",
  "GALLERY_FETCH_RESPONSE",
  "GALLERY_FETCH_ERROR",
]);
const STATUSES = new Set(["NOT_REQUESTED", "PENDING", "RUNNING", "PARTIAL", "COMPLETE", "FAILED"]);

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const authorizationError = authorizeGalleryTrace(request);
  if (authorizationError) return authorizationError;
  const listingId = (await params).id;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > 8_000) return Response.json({ ok: false, code: "GALLERY_TRACE_TOO_LARGE" }, { status: 413 });
    const body = await request.text();
    if (body.length > 8_000) return Response.json({ ok: false, code: "GALLERY_TRACE_TOO_LARGE" }, { status: 413 });
    const value: unknown = JSON.parse(body);
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    if (!row) return Response.json({ ok: false, code: "INVALID_GALLERY_TRACE" }, { status: 400 });
    const traceId = typeof row?.traceId === "string" && /^[a-z0-9-]{8,80}$/i.test(row.traceId) ? row.traceId : null;
    const stage = typeof row?.stage === "string" && STAGES.has(row.stage) ? row.stage : null;
    const status = typeof row?.galleryStatus === "string" && STATUSES.has(row.galleryStatus) ? row.galleryStatus : null;
    if (!traceId || !stage || !status) return Response.json({ ok: false, code: "INVALID_GALLERY_TRACE" }, { status: 400 });
    const postId = typeof row?.postId === "string" && /^\d{5,30}$/.test(row.postId) ? row.postId : null;
    const errorCode = typeof row?.errorCode === "string" ? row.errorCode.slice(0, 120) : null;
    const guard = typeof row?.guard === "string" ? row.guard.slice(0, 60) : null;
    const httpStatus = Number.isInteger(row?.httpStatus) && Number(row.httpStatus) >= 100 && Number(row.httpStatus) <= 599 ? Number(row.httpStatus) : null;
    console.info("FLIP_GALLERY_SERVER_TRACE", JSON.stringify({ traceId, stage, listingId, postId, galleryStatus: status, httpStatus, errorCode, guard, serverTimestamp: new Date().toISOString() }));
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, code: "INVALID_GALLERY_TRACE" }, { status: 400 });
  }
}
