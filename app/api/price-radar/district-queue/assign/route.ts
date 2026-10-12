import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { assignRadarDistrictQueueCandidate } from "@/features/price-radar/server/radar-district-queue";
import { readRadarSettings } from "@/features/price-radar/server/radar-settings";
import { RADAR_QUALITY_RULES_VERSION } from "@/features/price-radar/types";

export async function POST(request: Request) {
  let operator;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const body = (await request.json()) as { queueId?: unknown; district?: unknown };
    const queueId = typeof body.queueId === "string" ? body.queueId : null;
    const district = typeof body.district === "string" ? body.district : null;
    if (!queueId || !district) return Response.json({ message: "Brak identyfikatora oferty lub dzielnicy." }, { status: 400 });

    const settings = await readRadarSettings(operator.id);
    const result = await assignRadarDistrictQueueCandidate(operator.id, queueId, district, operator.id, RADAR_QUALITY_RULES_VERSION, undefined, settings.minPricePerSqm, settings.districts);
    if (!result.ok) {
      if (result.reason === "schema_unavailable") return Response.json({ message: "Kolejka przypisania dzielnicy nie jest jeszcze dostępna (wymagana migracja bazy)." }, { status: 503 });
      if (result.reason === "not_found") return Response.json({ message: "Nie znaleziono oferty w kolejce." }, { status: 404 });
      if (result.reason === "invalid_district") return Response.json({ message: "Nieprawidłowa dzielnica." }, { status: 400 });
      return Response.json({ message: "Oferta nie spełnia już pozostałych kryteriów Radaru i nie może zostać dodana do porównań.", reason: result.detail }, { status: 409 });
    }
    return Response.json({ ok: true, listingId: result.listingId });
  } catch (error) {
    console.error("PRICE RADAR DISTRICT QUEUE ASSIGN ERROR:", error);
    return Response.json({ message: "Nie udało się zapisać przypisania dzielnicy." }, { status: 500 });
  }
}
