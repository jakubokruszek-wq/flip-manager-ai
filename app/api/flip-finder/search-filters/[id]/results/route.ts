import { getFilterResults } from "@/features/flip-finder/server/filter-results";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Context) {
  try {
    const results = await getFilterResults((await params).id);

    if (!results) {
      return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 });
    }

    return Response.json(results);
  } catch (error) {
    console.error("FLIP FINDER RESULTS ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się pobrać wyników filtra." }, { status: 500 });
  }
}
