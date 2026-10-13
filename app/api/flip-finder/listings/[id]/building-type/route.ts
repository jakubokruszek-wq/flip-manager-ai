import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { isOperatorConfirmableBuildingType } from "@/features/flip-finder/building-type-qualification";
import {
  BuildingConfirmationUnavailableError,
  clearBuildingTypeConfirmation,
  saveBuildingTypeConfirmation,
} from "@/features/flip-finder/server/building-type-confirmations";
import { createAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Operator confirmation of a listing's building type ("Do weryfikacji
 * budynku" queue). Finder requalifies the listing on the next read; no
 * listing data or membership is deleted.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  const listingId = (await params).id;
  if (!UUID.test(listingId)) return Response.json({ message: "Nieprawidłowa oferta.", code: "BUILDING_TYPE_INVALID_ID" }, { status: 422 });
  const body = await request.json().catch(() => null) as { buildingType?: unknown; note?: unknown } | null;
  if (body?.buildingType === null) {
    try {
      await clearBuildingTypeConfirmation(createAdminClient() as never, listingId);
      return Response.json({ ok: true, listingId, buildingType: null });
    } catch (error) {
      return failure(error);
    }
  }
  if (!isOperatorConfirmableBuildingType(body?.buildingType)) {
    return Response.json({ message: "Nieprawidłowy typ budynku.", code: "BUILDING_TYPE_INVALID" }, { status: 422 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  try {
    await saveBuildingTypeConfirmation(createAdminClient() as never, { listingId, buildingType: body.buildingType, operatorId: operator.id, note });
    return Response.json({ ok: true, listingId, buildingType: body.buildingType });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown): Response {
  if (error instanceof BuildingConfirmationUnavailableError) {
    return Response.json({ message: error.message, code: "BUILDING_TYPE_CONFIRMATION_UNAVAILABLE" }, { status: 503 });
  }
  const message = error instanceof Error ? error.message : "Nie udało się zapisać typu budynku.";
  return Response.json({ message, code: "BUILDING_TYPE_CONFIRMATION_FAILED" }, { status: message === "Nie znaleziono oferty." ? 404 : 500 });
}
