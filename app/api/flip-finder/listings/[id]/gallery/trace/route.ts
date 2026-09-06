import { authorizeGalleryTrace, authorizeGalleryTraceRead } from "@/features/flip-finder/server/gallery-request-auth";
import { projectGalleryTrace, readGalleryTraces, writeGalleryTrace } from "@/features/flip-finder/server/gallery-request-trace";

type Context = { params: Promise<{ id: string }> };

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
    const trace = projectGalleryTrace(value, listingId);
    if (!trace) return Response.json({ ok: false, code: "INVALID_GALLERY_TRACE" }, { status: 400 });
    await writeGalleryTrace(trace);
    console.info("FLIP_GALLERY_SERVER_TRACE", JSON.stringify({ traceId: trace.traceId, event: trace.event, listingId, postId: trace.postId, source: trace.source, component: trace.component, buttonRendered: trace.buttonRendered, clientBuild: trace.clientBuild, instanceId: trace.instanceId, actionStage: trace.actionStage, errorName: trace.errorName, closestButtonFound: trace.closestButtonFound, galleryStatus: trace.galleryStatus, serverTimestamp: new Date().toISOString() }));
    return Response.json({ ok: true, traceId: trace.traceId });
  } catch {
    return Response.json({ ok: false, code: "GALLERY_TRACE_STORE_FAILED" }, { status: 503 });
  }
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const authorizationError = authorizeGalleryTraceRead(request);
  if (authorizationError) return authorizationError;
  const listingId = (await params).id;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ ok: false, code: "INVALID_LISTING_ID" }, { status: 400 });
  const traceId = new URL(request.url).searchParams.get("traceId") || undefined;
  if (traceId && !/^[A-Za-z0-9-]{8,80}$/.test(traceId)) return Response.json({ ok: false, code: "INVALID_TRACE_ID" }, { status: 400 });
  try {
    return Response.json({ ok: true, events: await readGalleryTraces(listingId, traceId) });
  } catch {
    return Response.json({ ok: false, code: "GALLERY_TRACE_READ_FAILED" }, { status: 503 });
  }
}
