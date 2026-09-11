import { getInvestmentDeal, saveDealOverrides } from "@/features/investment-os/server/deal-service";
import type { DealFactOverrides } from "@/features/investment-os/types";
import { authorizeInvestmentMutation } from "@/features/investment-os/server/request-auth";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  try {
    const deal = await getInvestmentDeal((await params).id);
    return deal ? Response.json({ ok: true, deal }) : Response.json({ message: "Nie znaleziono oferty." }, { status: 404 });
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
    console.error("INVESTMENT DEAL PUT ERROR", error);
    return Response.json({ message: error instanceof Error && error.message.startsWith("INVALID_") ? "Nieprawidłowa wartość." : "Nie udało się zapisać nadpisania." }, { status: 500 });
  }
}
