import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";

import { ClearResultsConflictError, clearFilterResults } from "@/features/flip-finder/server/clear-results";
import { LISTING_SOURCES } from "@/features/flip-finder";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  const filterId = (await params).id;
  const body = await request.json().catch(() => null) as { source?: unknown; olderThanDays?: unknown } | null;
  const source = typeof body?.source === "string" && (LISTING_SOURCES as readonly string[]).includes(body.source) ? body.source as (typeof LISTING_SOURCES)[number] : undefined;
  const olderThanDays = typeof body?.olderThanDays === "number" && Number.isFinite(body.olderThanDays) && body.olderThanDays > 0 ? body.olderThanDays : undefined;
  try {
    const result = await clearFilterResults(filterId, { source, olderThanDays });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ClearResultsConflictError) {
      return Response.json({ message: error.message }, { status: error.status });
    }
    console.error("FLIP FINDER CLEAR RESULTS ERROR:", { filterId, error });
    return Response.json({ message: error instanceof Error ? error.message : "Nie udało się wyczyścić wyników." }, { status: 500 });
  }
}
