const ALLOWED_ORIGINS = new Set([
  "https://flip-manager-ai.vercel.app",
  "http://localhost:3000",
]);

export function authorizeHistoryClear(request: Request): Response | null {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const fetchSite = request.headers.get("sec-fetch-site");
  const action = request.headers.get("x-flip-finder-action");

  if (!origin || !ALLOWED_ORIGINS.has(origin)) return forbidden();
  if (fetchSite && fetchSite !== "same-origin") return forbidden();
  if (action !== "clear-search-history") return forbidden();
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
  return Response.json({ ok: false, code: "HISTORY_CLEAR_FORBIDDEN" }, { status: 403 });
}
