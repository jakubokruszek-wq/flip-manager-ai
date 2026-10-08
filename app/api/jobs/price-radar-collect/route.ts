import { claimOrCreateRadarRun, runRadarCollectionPortion } from "@/features/price-radar/server/collect";

/**
 * DRAFT, NOT WIRED TO ANY CRON YET -- see this mission's final report for
 * the exact vercel.json entry to add when ready (deliberately not added to
 * the real vercel.json as part of this change, so it cannot go live on a
 * later unrelated deploy without a separate, reviewed decision).
 *
 * Reuses the existing CRON_SECRET this project already has configured for
 * /api/jobs/facebook-watch -- no new secret, no new paid service. Claims
 * (or resumes) the single allowed Radar run and processes one time-boxed
 * portion. If a day's collection does not finish within one portion's
 * budget, the run stays "running" and the NEXT scheduled trigger continues
 * it (claimOrCreateRadarRun resumes the same run, never starts a second
 * one) -- a slower first day or two, then a steady daily cadence once
 * sources' response times settle.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) {
    return Response.json({ error: "Brak CRON_SECRET w konfiguracji serwera." }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const suppliedSecret = bearer ?? request.headers.get("x-cron-secret");
  if (suppliedSecret !== process.env.CRON_SECRET) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const claim = await claimOrCreateRadarRun();
  if (claim.kind === "blocked") {
    return Response.json({ message: "Inny przebieg Radaru już trwa." }, { status: 409 });
  }
  const portion = await runRadarCollectionPortion(claim.run.id);
  return Response.json({ runId: claim.run.id, ...portion });
}

export const GET = POST;
