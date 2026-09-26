import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { createSearchFilter, listSearchFilters, parseSearchFilterInput, SearchFilterWriteError } from "@/features/flip-finder/server/search-filters";
import type { SearchFilterInput } from "@/features/flip-finder/search-filter-contract";

// Surfaces the real database error code/message instead of always the same
// generic string, so a permission error, a check-constraint violation, or a
// missing server credential are each distinguishable by the operator instead
// of looking identical.
function writeFailureResponse(error: unknown, fallbackMessage: string): Response {
  if (error instanceof SearchFilterWriteError) {
    return Response.json({ message: `${fallbackMessage} (${error.code}): ${error.message}` }, { status: 500 });
  }
  return Response.json({ message: fallbackMessage }, { status: 500 });
}

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
  catch (error) { console.error("FLIP FINDER CREATE WRITE ERROR:", error); return writeFailureResponse(error, "Nie udało się utworzyć filtra."); }
}
