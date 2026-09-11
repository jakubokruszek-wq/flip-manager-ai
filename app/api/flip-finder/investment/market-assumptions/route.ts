import { listMarketAssumptions, saveMarketAssumption } from "@/features/investment-os/server/deal-service";
import { authorizeInvestmentMutation } from "@/features/investment-os/server/request-auth";

export async function GET(): Promise<Response> {
  try { return Response.json({ ok: true, assumptions: await listMarketAssumptions() }); }
  catch (error) { console.error("MARKET ASSUMPTIONS GET ERROR", error); return Response.json({ message: "Nie udało się pobrać założeń rynku." }, { status: 500 }); }
}
export async function POST(request: Request): Promise<Response> {
  const denied = authorizeInvestmentMutation(request); if (denied) return denied;
  try { return Response.json({ ok: true, assumption: await saveMarketAssumption(await request.json().catch(() => null)) }, { status: 201 }); }
  catch (error) { console.error("MARKET ASSUMPTIONS POST ERROR", error); return Response.json({ message: "Nieprawidłowe założenie rynku." }, { status: 400 }); }
}
