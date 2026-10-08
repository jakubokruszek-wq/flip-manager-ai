import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { excludeRadarListing, restoreRadarListing } from "@/features/price-radar/server/radar-exclusion";

export async function POST(request: Request) {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const body = (await request.json()) as { listingId?: unknown; excluded?: unknown; reason?: unknown };
    const listingId = typeof body.listingId === "string" ? body.listingId : null;
    const excluded = body.excluded !== false;
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    if (!listingId) return Response.json({ message: "Brak identyfikatora oferty." }, { status: 400 });

    const result = excluded ? await excludeRadarListing(listingId, reason) : await restoreRadarListing(listingId);
    if (!result.ok) return Response.json({ message: "Nie znaleziono oferty Radaru." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("PRICE RADAR EXCLUDE ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się zaktualizować wykluczenia." }, { status: 500 });
  }
}
