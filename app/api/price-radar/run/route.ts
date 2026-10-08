import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { claimOrCreateRadarRun, runRadarCollectionPortion } from "@/features/price-radar/server/collect";

/**
 * Manual/operator-triggered Radar collection portion. Claims (or resumes)
 * the single allowed run and processes one time-boxed portion of it --
 * exactly the same function a daily cron would call, just invoked by hand.
 * No cron currently calls this route; see the draft note in
 * supabase/migrations/20261008000000_create_price_radar.sql and this
 * mission's final report for the exact, not-yet-added vercel.json entry.
 */
export async function POST() {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const claim = await claimOrCreateRadarRun();
    if (claim.kind === "blocked") {
      return Response.json({ message: "Inny przebieg Radaru już trwa." }, { status: 409 });
    }
    const portion = await runRadarCollectionPortion(claim.run.id);
    return Response.json({ runId: claim.run.id, ...portion });
  } catch (error) {
    console.error("PRICE RADAR RUN ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się uruchomić zbierania Radaru." }, { status: 500 });
  }
}
