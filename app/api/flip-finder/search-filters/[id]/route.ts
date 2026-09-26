import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { deleteSearchFilter, getSearchFilter, parseSearchFilterInput, SearchFilterWriteError, updateSearchFilter } from "@/features/flip-finder/server/search-filters";
import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";
import type { SearchFilterInput } from "@/features/flip-finder/search-filter-contract";

type Context = { params: Promise<{ id: string }> };

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

export async function GET(_request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try { const filter = await getSearchFilter((await params).id); return filter ? Response.json(filter) : Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); }
  catch { return Response.json({ message: "Nie udało się pobrać filtra." }, { status: 500 }); }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  let input: SearchFilterInput;
  try { input = parseSearchFilterInput(await request.json()); }
  catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Nieprawidłowe dane filtra." }, { status: 400 }); }
  try { const filterId = (await params).id; const filter = await updateSearchFilter(filterId, input); if (!filter) return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); try { const recalculation = await recalculateFilterMatches(filterId, { allowWithoutScan: true }); return Response.json({ filter, recalculation }); } catch (error) { console.error("FLIP FINDER EDIT RECALCULATE ERROR:", error); return Response.json({ filter, recalculation: null, recalculationWarning: "Filtr zapisano, ale nie udało się odświeżyć wyników." }); } }
  catch (error) { console.error("FLIP FINDER EDIT WRITE ERROR:", error); return writeFailureResponse(error, "Nie udało się zapisać filtra."); }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try { return await deleteSearchFilter((await params).id) ? new Response(null, { status: 204 }) : Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); }
  catch { return Response.json({ message: "Nie udało się usunąć filtra." }, { status: 500 }); }
}
