import { getFilterResults } from "@/features/flip-finder/server/filter-results";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, { params }: Context) {
  try {
    const includeArchived = new URL(request.url).searchParams.get("view") === "archive";
    const results = await getFilterResults((await params).id, includeArchived);

    if (!results) {
      return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 });
    }

    return Response.json(results);
  } catch (error) {
    console.error("FLIP FINDER RESULTS ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się pobrać wyników filtra." }, { status: 500 });
  }
}
