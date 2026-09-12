import { loadInvestmentSettings, saveInvestmentSettings } from "@/features/investment-os/server/deal-service";
import { isInvestmentDealVersionConflict } from "@/features/investment-os/server/deal-cas";
import { authorizeInvestmentMutation } from "@/features/investment-os/server/request-auth";

export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, settings: await loadInvestmentSettings() });
  } catch (error) {
    console.error("INVESTMENT SETTINGS GET ERROR", error);
    return Response.json({ message: "Nie udało się pobrać ustawień." }, { status: 500 });
  }
}

export async function PUT(request: Request): Promise<Response> {
  const denied = authorizeInvestmentMutation(request);
  if (denied) return denied;
  try {
    return Response.json({ ok: true, settings: await saveInvestmentSettings(await request.json().catch(() => null)) });
  } catch (error) {
    if (isInvestmentDealVersionConflict(error)) return Response.json({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, { status: 409 });
    console.error("INVESTMENT SETTINGS PUT ERROR", error);
    return Response.json({ message: "Nieprawidłowe ustawienia." }, { status: 400 });
  }
}
