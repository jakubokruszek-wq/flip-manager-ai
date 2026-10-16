import { testListingAllowed } from "@/features/investment-os/test-mode";
import { assertDealRoomOwner, DealRoomNotFound } from "@/features/investment-os/server/deal-room-service";
import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { initializeInvestmentDeal } from "@/features/investment-os/server/deal-service";
import { isInvestmentDealVersionConflict } from "@/features/investment-os/server/deal-cas";
import { investmentInitializeResponse } from "@/features/investment-os/server/investment-initialize";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  let actorId = "";
  try {
    const actor = await requireOperator();
    actorId = actor.id;
    if (!testListingAllowed((await params).id, actor.id)) throw new DealRoomNotFound();
    await assertDealRoomOwner((await params).id, actor.id);
  } catch (error) {
    if (error instanceof DealRoomNotFound) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    return operatorAuthorizationResponse(error);
  }
  try {
    return await investmentInitializeResponse((await params).id, (listingId) => initializeInvestmentDeal(listingId, actorId));
  } catch (error) {
    if (isInvestmentDealVersionConflict(error)) {
      return Response.json({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, { status: 409 });
    }
    if (error instanceof DealRoomNotFound) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    console.error("INVESTMENT DEAL INITIALIZE ERROR", error);
    return Response.json({ ok: false, message: "Nie udało się zainicjalizować Investment Desk." }, { status: 500 });
  }
}
