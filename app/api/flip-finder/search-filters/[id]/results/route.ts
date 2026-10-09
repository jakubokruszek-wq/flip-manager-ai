import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { getFilterResults } from "@/features/flip-finder/server/filter-results";

// getFilterResults does multiple paginated, ID-chunked reads across listings,
// listing_snapshots, listing_source_metadata and resale_comps -- the same
// kind of multi-table DB-heavy work scans/[runId]/continue and
// search-filters/[id]/scan already set this for. Unlike those, this route
// had no override and fell back to the platform default, well under this
// query's worst case next to an active multi-source scan writing to the same
// tables concurrently.
export const maxDuration = 60;

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, { params }: Context) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const includeArchived = new URL(request.url).searchParams.get("view") === "archive";
    const results = await getFilterResults((await params).id, includeArchived, Date.now(), operator.id);

    if (!results) {
      return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 });
    }

    return Response.json(results);
  } catch (error) {
    console.error("FLIP FINDER RESULTS ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się pobrać wyników filtra." }, { status: 500 });
  }
}
