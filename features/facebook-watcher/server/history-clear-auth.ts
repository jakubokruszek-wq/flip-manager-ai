const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);

export function authorizeFacebookWatcherAction(request: Request, action: "clear-watcher-history" | "repair-gallery"): Response | null {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || !ALLOWED_ORIGINS.has(origin) || (fetchSite && fetchSite !== "same-origin") || request.headers.get("x-facebook-watcher-action") !== action) {
    return Response.json({ ok: false, code: "FACEBOOK_WATCHER_ACTION_FORBIDDEN" }, { status: 403 });
  }
  return null;
}
