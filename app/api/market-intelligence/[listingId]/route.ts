import { analyzeMarket } from "@/features/market-intelligence/analyze-market";

type Context = { params: Promise<{ listingId: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const marketIntelligence = await analyzeMarket((await params).listingId);
    if (!marketIntelligence) {
      return Response.json({ message: "Nie znaleziono oferty." }, { status: 404 });
    }
    return Response.json(marketIntelligence);
  } catch (error) {
    console.error("MARKET INTELLIGENCE ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się przeanalizować rynku dla oferty." }, { status: 500 });
  }
}
