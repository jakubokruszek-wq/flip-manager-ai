import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { getRadarVerificationQueue } from "@/features/price-radar/server/radar-verification-queue";

export async function GET() {
  let operator;
  try { operator = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    return Response.json(await getRadarVerificationQueue(operator.id));
  } catch (error) {
    console.error("PRICE RADAR VERIFICATION QUEUE READ ERROR:", error);
    return Response.json({ message: "Nie udało się odczytać kolejki weryfikacji Radaru." }, { status: 500 });
  }
}
