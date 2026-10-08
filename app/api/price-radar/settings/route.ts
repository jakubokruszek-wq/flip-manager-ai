import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { readRadarSettings, writeRadarSettings } from "@/features/price-radar/server/radar-settings";
import { RADAR_SOURCES } from "@/features/price-radar/server/collect";

export async function GET() {
  let operator;
  try { operator = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    return Response.json({ filters: await readRadarSettings(operator.id), activeSources: RADAR_SOURCES, disabledSourceNote: "Źródła poza wspólną bramką Findera pozostają wyłączone w Radarze." });
  } catch {
    return Response.json({ message: "Nie udało się odczytać filtrów Radaru." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  let operator;
  try { operator = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    const body = await request.json() as { filters?: unknown };
    return Response.json({ filters: await writeRadarSettings(operator.id, body.filters) });
  } catch {
    return Response.json({ message: "Nie udało się zapisać filtrów Radaru." }, { status: 500 });
  }
}
