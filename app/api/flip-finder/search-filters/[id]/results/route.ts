import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { getFilterResults } from "@/features/flip-finder/server/filter-results";

// The active view reads only current MATCHED + REVIEW memberships; the
// archive is paged (?view=archive&offset=&limit=). The ceiling stays for a
// cold read next to an active multi-source scan writing to the same tables.
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
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);
    const view = url.searchParams.get("view") === "archive" ? "archive" : "active";
    const results = await getFilterResults((await params).id, view === "archive", Date.now(), operator.id, {
      view,
      archiveOffset: Number(url.searchParams.get("offset") ?? 0),
      archiveLimit: Number(url.searchParams.get("limit") ?? 0) || undefined,
    });

    if (!results) {
      return Response.json({ message: "Nie znaleziono filtra.", code: "FINDER_FILTER_NOT_FOUND" }, { status: 404 });
    }

    return Response.json(results, { headers: { "Server-Timing": `finder;dur=${Date.now() - startedAt}`, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("FLIP FINDER RESULTS ROUTE ERROR:", error);
    // Operator-only route: return the real (already user-facing, Polish)
    // cause so the Finder shows an actual error instead of looking empty.
    return Response.json({
      message: "Nie udało się pobrać wyników filtra.",
      detail: error instanceof Error ? error.message : null,
      code: "FINDER_RESULTS_READ_FAILED",
    }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
