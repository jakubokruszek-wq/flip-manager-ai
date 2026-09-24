const ALLOWED_ORIGINS = new Set([
  "https://flip-manager-ai.vercel.app",
  "http://localhost:3000",
]);

export type ListingLifecycleAction = "clear-results" | "review-listing";

/** Protects service-role lifecycle mutations exposed through Finder routes. */
export function authorizeListingLifecycleMutation(request: Request, expectedAction: ListingLifecycleAction): Response | null {
  const origin = normalizeOrigin(request.headers.get("origin"));
  const fetchSite = request.headers.get("sec-fetch-site");
  const action = request.headers.get("x-flip-finder-action");
  if (!origin || !ALLOWED_ORIGINS.has(origin) || (fetchSite && fetchSite !== "same-origin") || action !== expectedAction) {
    return Response.json({ ok: false, code: "LISTING_LIFECYCLE_MUTATION_FORBIDDEN" }, { status: 403 });
  }
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
