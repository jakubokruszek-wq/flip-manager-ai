const ALLOWED_ORIGINS = new Set([
  "https://flip-manager-ai.vercel.app",
  "http://localhost:3000",
]);

/**
 * Gallery jobs are created only by the Finder UI. The database is never
 * written directly by the browser; this guard also prevents cross-site POSTs
 * from reaching the service-role enqueue path.
 */
export function authorizeGalleryMutation(request: Request): Response | null {
  return authorizeGalleryRequest(request, "gallery");
}

export function authorizeGalleryTrace(request: Request): Response | null {
  return authorizeGalleryRequest(request, "gallery-trace");
}

export function authorizeGalleryTraceRead(request: Request): Response | null {
  return authorizeGalleryRequest(request, "gallery-trace-read");
}

function authorizeGalleryRequest(request: Request, expectedAction: "gallery" | "gallery-trace" | "gallery-trace-read"): Response | null {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const fetchSite = request.headers.get("sec-fetch-site");
  const action = request.headers.get("x-flip-finder-action");

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return forbidden();
  if (fetchSite && fetchSite !== "same-origin") return forbidden();
  if (action !== expectedAction) return forbidden();
  return null;
}

function normalizeOrigin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function forbidden(): Response {
  return Response.json({ ok: false, code: "GALLERY_REQUEST_FORBIDDEN" }, { status: 403 });
}
