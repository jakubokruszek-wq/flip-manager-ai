import { duplicateSearchFilter } from "@/features/flip-finder/server/search-filters";
type Context = { params: Promise<{ id: string }> };
export async function POST(_request: Request, { params }: Context) { try { const filter = await duplicateSearchFilter((await params).id); return filter ? Response.json(filter, { status: 201 }) : Response.json({ message: "Nie znaleziono filtra." }, { status: 404 }); } catch { return Response.json({ message: "Nie udało się zduplikować filtra." }, { status: 500 }); } }
