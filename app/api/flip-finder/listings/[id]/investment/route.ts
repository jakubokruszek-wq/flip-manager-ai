import { getInvestmentDeal, saveDealOverrides } from "@/features/investment-os/server/deal-service";
import type { DealFactOverrides } from "@/features/investment-os/types";
import { authorizeInvestmentMutation } from "@/features/investment-os/server/request-auth";
import { isInvestmentDealVersionConflict } from "@/features/investment-os/server/deal-cas";
import { investmentDealReadResponse } from "@/features/investment-os/server/investment-read";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  try {
    return await investmentDealReadResponse((await params).id, getInvestmentDeal);
  } catch (error) {
    console.error("INVESTMENT DEAL GET ERROR", error);
    return Response.json({ message: "Nie udało się przygotować Investment Desk." }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const denied = authorizeInvestmentMutation(request); if (denied) return denied;
  try {
    const body = await request.json().catch(() => null) as { overrides?: DealFactOverrides } | null;
    if (!body?.overrides || typeof body.overrides !== "object" || Array.isArray(body.overrides)) return Response.json({ message: "Nieprawidłowe nadpisania." }, { status: 400 });
    const result = await saveDealOverrides((await params).id, body.overrides);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (isInvestmentDealVersionConflict(error)) return Response.json({ ok: false, code: "INVESTMENT_DEAL_VERSION_CONFLICT" }, { status: 409 });
    console.error("INVESTMENT DEAL PUT ERROR", error);
    return Response.json({ message: error instanceof Error && error.message.startsWith("INVALID_") ? "Nieprawidłowa wartość." : "Nie udało się zapisać nadpisania." }, { status: 500 });
  }
}
