import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { createSearchFilter, listSearchFilters, parseSearchFilterInput, searchFilterWriteFailureResponse } from "@/features/flip-finder/server/search-filters";
import { getFilterResults } from "@/features/flip-finder/server/filter-results";
import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";
import type { SearchFilterInput } from "@/features/flip-finder/search-filter-contract";

export const maxDuration = 60;

export async function GET() {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const payload = await listSearchFilters();
    const now = Date.now();
    const filters = await mapWithConcurrency(payload.filters, 3, async (filter) => {
      if (filter.membershipRows === 0) return { ...filter, totalMatches: 0 };
      const results = await getFilterResults(filter.id, false, now, operator.id);
      return {
        ...filter,
        totalMatches: results ? results.results.length + results.reviewResults.length : 0,
      };
    });
    return Response.json({ ...payload, filters });
  }
  catch { return Response.json({ message: "Nie udało się pobrać filtrów." }, { status: 500 }); }
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index]!);
    }
  }));
  return output;
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
