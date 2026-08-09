import { createSearchFilter, listSearchFilters, parseSearchFilterInput } from "@/features/flip-finder/server/search-filters";
import type { SearchFilterInput } from "@/features/flip-finder/search-filter-contract";

export async function GET() {
  try { return Response.json(await listSearchFilters()); }
  catch { return Response.json({ message: "Nie udało się pobrać filtrów." }, { status: 500 }); }
}

export async function POST(request: Request) {
  let input: SearchFilterInput;
  try { input = parseSearchFilterInput(await request.json()); }
  catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Nieprawidłowe dane filtra." }, { status: 400 }); }
  try { return Response.json(await createSearchFilter(input), { status: 201 }); }
  catch { return Response.json({ message: "Nie udało się utworzyć filtra." }, { status: 500 }); }
}
