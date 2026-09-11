const ALLOWED_ORIGINS = new Set(["https://flip-manager-ai.vercel.app", "http://localhost:3000"]);

export function authorizeInvestmentMutation(request: Request): Response | null {
  const origin = request.headers.get("origin");
  const action = request.headers.get("x-flip-finder-action");
  const fetchSite = request.headers.get("sec-fetch-site");
  try {
    if (!origin || !ALLOWED_ORIGINS.has(new URL(origin).origin) || (fetchSite && fetchSite !== "same-origin") || action !== "investment-os") return forbidden();
  } catch { return forbidden(); }
  return null;
}
function forbidden(): Response { return Response.json({ ok: false, code: "INVESTMENT_MUTATION_FORBIDDEN" }, { status: 403 }); }
