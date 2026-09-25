import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { loadInvestmentSettings, saveInvestmentSettings } from "@/features/investment-os/server/deal-service";
import { isInvestmentDealVersionConflict } from "@/features/investment-os/server/deal-cas";

export async function GET(): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    return Response.json({ ok: true, settings: await loadInvestmentSettings() });
  } catch (error) {
    console.error("INVESTMENT SETTINGS GET ERROR", error);
    return Response.json({ message: "Nie udało się pobrać ustawień." }, { status: 500 });
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    return Response.json({ ok: true, settings: await saveInvestmentSettings(await request.json().catch(() => null)) });
  } catch (error) {
    if (isInvestmentDealVersionConflict(error)) return Response.json({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, { status: 409 });
    console.error("INVESTMENT SETTINGS PUT ERROR", error);
    return Response.json({ message: "Nieprawidłowe ustawienia." }, { status: 400 });
  }
}
