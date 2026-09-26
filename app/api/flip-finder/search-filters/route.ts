import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { createSearchFilter, listSearchFilters, parseSearchFilterInput, searchFilterWriteFailureResponse } from "@/features/flip-finder/server/search-filters";
import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";
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
  let filter: Awaited<ReturnType<typeof createSearchFilter>>;
  try { filter = await createSearchFilter(input); }
  catch (error) { console.error("FLIP FINDER CREATE WRITE ERROR:", error); return searchFilterWriteFailureResponse(error, "Nie udało się utworzyć filtra."); }
  // A newly created filter must be matched against already-saved public.listings
  // right away -- the same reconciliation the edit path already runs -- rather
  // than sitting empty until the next scheduled/manual scan. This never
  // touches Facebook/OLX/Otodom/Morizon: recalculateFilterMatches only reads
  // rows already collected in public.listings.
  try {
    const recalculation = await recalculateFilterMatches(filter.id, { allowWithoutScan: true });
    return Response.json({ filter, recalculation }, { status: 201 });
  } catch (error) {
    console.error("FLIP FINDER CREATE RECALCULATE ERROR:", error);
    return Response.json({ filter, recalculation: null, recalculationWarning: "Filtr utworzono, ale nie udało się przeliczyć wyników." }, { status: 201 });
  }
}
