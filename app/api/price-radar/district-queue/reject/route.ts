import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { setRadarDistrictQueueRejection } from "@/features/price-radar/server/radar-district-queue";

export async function POST(request: Request) {
  let operator;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const body = (await request.json()) as { queueId?: unknown; rejected?: unknown };
    const queueId = typeof body.queueId === "string" ? body.queueId : null;
    const rejected = body.rejected !== false;
    if (!queueId) return Response.json({ message: "Brak identyfikatora oferty." }, { status: 400 });

    const result = await setRadarDistrictQueueRejection(operator.id, queueId, rejected);
    if (!result.ok) {
      if (result.reason === "schema_unavailable") return Response.json({ message: "Kolejka przypisania dzielnicy nie jest jeszcze dostępna (wymagana migracja bazy)." }, { status: 503 });
      return Response.json({ message: "Nie znaleziono oferty w kolejce." }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error("PRICE RADAR DISTRICT QUEUE REJECT ERROR:", error);
    return Response.json({ message: "Nie udało się zaktualizować decyzji." }, { status: 500 });
  }
}
