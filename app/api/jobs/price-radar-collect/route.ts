import { claimOrCreateRadarRun, runRadarCollectionPortion } from "@/features/price-radar/server/collect";
import { createAdminClient } from "@/lib/supabase/admin";
import { readRadarSettings } from "@/features/price-radar/server/radar-settings";

/** Draft endpoint; no active cron entry is added by this mission. */
export const runtime = "nodejs";
export const maxDuration = 55;

export async function POST(request: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "Brak CRON_SECRET w konfiguracji serwera." }, { status: 503 });
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const suppliedSecret = bearer ?? request.headers.get("x-cron-secret");
  if (suppliedSecret !== process.env.CRON_SECRET) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: owners, error } = await admin.from("price_radar_settings").select("owner_id").order("updated_at", { ascending: true }).limit(100);
  if (error) return Response.json({ error: "RADAR_OWNER_READ_FAILED" }, { status: 500 });
  for (const row of owners ?? []) {
    if (typeof row.owner_id !== "string") continue;
    const settings = await readRadarSettings(row.owner_id, admin);
    const claim = await claimOrCreateRadarRun(row.owner_id, settings.sources, admin);
    if (claim.kind === "blocked" || !claim.run.leaseToken) continue;
    const portion = await runRadarCollectionPortion({ runId: claim.run.id, ownerId: row.owner_id, leaseToken: claim.run.leaseToken }, admin);
    await admin.from("price_radar_settings").update({ updated_at: new Date().toISOString() }).eq("owner_id", row.owner_id);
    return Response.json({ runId: claim.run.id, ...portion });
  }
  return Response.json({ status: "idle", message: "Brak właściciela Radaru gotowego do pobrania porcji." });
}
