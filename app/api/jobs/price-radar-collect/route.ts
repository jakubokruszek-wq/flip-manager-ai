/** The former asking-price collector has been replaced by the on-demand RCN Radar. */
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const secret = process.env.PRICE_RADAR_CRON_SECRET;
  if (!secret) return Response.json({ error: "Brak PRICE_RADAR_CRON_SECRET w konfiguracji serwera." }, { status: 503 });
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? request.headers.get("x-cron-secret");
  if (supplied !== secret) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // A terminal response also stops queued continuations/watchdog ticks without
  // reading old settings, claiming runs, registering timers or collecting offers.
  return Response.json({ status: "completed", retired: true, reason: "RCN_RADAR_REPLACED_ASKING_COLLECTOR" }, { headers: { "Cache-Control": "private, no-store" } });
}
