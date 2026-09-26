import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { createSearchFilter, listSearchFilters, parseSearchFilterInput, searchFilterWriteFailureResponse } from "@/features/flip-finder/server/search-filters";
import type { SearchFilterInput } from "@/features/flip-finder/search-filter-contract";

export async function GET() {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try { return Response.json(await listSearchFilters()); }
  catch { return Response.json({ message: "Nie udało się pobrać filtrów." }, { status: 500 }); }
}

export async function POST(request: Request) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  let input: SearchFilterInput;
  try { input = parseSearchFilterInput(await request.json()); }
  catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Nieprawidłowe dane filtra." }, { status: 400 }); }
  try { return Response.json(await createSearchFilter(input), { status: 201 }); }
  catch (error) { console.error("FLIP FINDER CREATE WRITE ERROR:", error); return searchFilterWriteFailureResponse(error, "Nie udało się utworzyć filtra."); }
}
