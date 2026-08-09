import { deleteSearchFilter, getSearchFilter, parseSearchFilterInput, updateSearchFilter } from "@/features/flip-finder/server/search-filters";
import { recalculateFilterMatches } from "@/features/flip-finder/server/filter-match-recalculation";
import type { SearchFilterInput } from "@/features/flip-finder/search-filter-contract";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  try { const filter = await getSearchFilter((await params).id); return filter ? Response.json(filter) : Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); }
  catch { return Response.json({ message: "Nie udało się pobrać filtra." }, { status: 500 }); }
}

export async function PATCH(request: Request, { params }: Context) {
  let input: SearchFilterInput;
  try { input = parseSearchFilterInput(await request.json()); }
  catch (error) { return Response.json({ message: error instanceof Error ? error.message : "Nieprawidłowe dane filtra." }, { status: 400 }); }
  try { const filterId = (await params).id; const filter = await updateSearchFilter(filterId, input); if (!filter) return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); try { const recalculation = await recalculateFilterMatches(filterId); return Response.json({ filter, recalculation }); } catch (error) { console.error("FLIP FINDER EDIT RECALCULATE ERROR:", error); return Response.json({ filter, recalculation: null, recalculationWarning: "Filtr zapisano, ale nie udało się odświeżyć wyników." }); } }
  catch { return Response.json({ message: "Nie udało się zapisać filtra." }, { status: 500 }); }
}

export async function DELETE(_request: Request, { params }: Context) {
  try { return await deleteSearchFilter((await params).id) ? new Response(null, { status: 204 }) : Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); }
  catch { return Response.json({ message: "Nie udało się usunąć filtra." }, { status: 500 }); }
}
