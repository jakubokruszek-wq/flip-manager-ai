import { initializeInvestmentDeal } from "@/features/investment-os/server/deal-service";
import { isInvestmentDealVersionConflict } from "@/features/investment-os/server/deal-cas";
import { investmentInitializeResponse } from "@/features/investment-os/server/investment-initialize";
import { authorizeInvestmentMutation } from "@/features/investment-os/server/request-auth";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const denied = authorizeInvestmentMutation(request);
  if (denied) return denied;
  try {
    return await investmentInitializeResponse((await params).id, initializeInvestmentDeal);
  } catch (error) {
    if (isInvestmentDealVersionConflict(error)) {
      return Response.json({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, { status: 409 });
    }
    console.error("INVESTMENT DEAL INITIALIZE ERROR", error);
    return Response.json({ ok: false, message: "Nie udało się zainicjalizować Investment Desk." }, { status: 500 });
  }
}
