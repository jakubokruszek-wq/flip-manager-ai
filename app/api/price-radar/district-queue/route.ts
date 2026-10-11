import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { getRadarDistrictQueue } from "@/features/price-radar/server/radar-district-queue";

export async function GET() {
  let operator;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const queue = await getRadarDistrictQueue(operator.id);
    return Response.json(queue);
  } catch (error) {
    console.error("PRICE RADAR DISTRICT QUEUE READ ERROR:", error);
    return Response.json({ message: "Nie udało się odczytać kolejki przypisania dzielnicy." }, { status: 500 });
  }
}
