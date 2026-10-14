import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { getFinderOlxScheduleStatus } from "@/features/flip-finder/server/finder-olx-schedule";
import { getSearchFilter } from "@/features/flip-finder/server/search-filters";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Read-only OLX schedule diagnostics of one filter: last OLX order, next
 * allowed time, skip reason and the shared 24 h budget. A dry run of the
 * database decision; nothing is queued and no retry is possible from here.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    const filter = await getSearchFilter((await params).id);
    if (!filter) return Response.json({ message: "Nie znaleziono filtra." }, { status: 404 });
    return Response.json(await getFinderOlxScheduleStatus(createAdminClient(), filter), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Nie udało się odczytać harmonogramu OLX." }, { status: 500 });
  }
}
