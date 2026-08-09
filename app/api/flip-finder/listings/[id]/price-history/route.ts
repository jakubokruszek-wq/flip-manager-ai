import { getListingPriceHistory } from "@/features/flip-finder/server/price-history";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Context) {
  try {
    const history = await getListingPriceHistory((await params).id);

    if (!history) {
      return Response.json({ message: "Nie znaleziono oferty." }, { status: 404 });
    }

    return Response.json(history);
  } catch (error) {
    console.error("FLIP FINDER PRICE HISTORY ROUTE ERROR:", error);
    return Response.json(
      { message: "Nie udało się pobrać historii ceny oferty." },
      { status: 500 },
    );
  }
}
