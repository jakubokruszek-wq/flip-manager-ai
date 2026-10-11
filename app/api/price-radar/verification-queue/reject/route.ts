import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { setRadarVerificationQueueRejection } from "@/features/price-radar/server/radar-verification-queue";

export async function POST(request: Request) {
  let operator;
  try { operator = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    const body = await request.json() as { queueId?: unknown; rejected?: unknown };
    if (typeof body.queueId !== "string" || !body.queueId) return Response.json({ message: "Brak identyfikatora oferty." }, { status: 400 });
    const result = await setRadarVerificationQueueRejection(operator.id, body.queueId, body.rejected !== false);
    if (!result.ok) {
      return Response.json({ message: result.reason === "schema_unavailable" ? "Kolejka weryfikacji wymaga migracji bazy." : "Nie znaleziono oferty w kolejce." }, { status: result.reason === "schema_unavailable" ? 503 : 404 });
    }
    return Response.json({ ok: true });
  } catch (error) {
    console.error("PRICE RADAR VERIFICATION REJECTION ERROR:", error);
    return Response.json({ message: "Nie udało się zapisać decyzji o ofercie." }, { status: 500 });
  }
}
