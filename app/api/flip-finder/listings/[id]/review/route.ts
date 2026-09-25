import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { createAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request, { params }: Context): Promise<Response> {
  try {
    await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }

  const listingId = (await params).id;
  if (!UUID.test(listingId)) {
    return Response.json({ message: "Nieprawidłowa oferta.", code: "LISTING_REVIEW_INVALID_ID" }, { status: 422 });
  }

  const body = await request.json().catch(() => null) as { decision?: unknown; reason?: unknown } | null;
  const decision = body?.decision === "ACCEPTED" || body?.decision === "REJECTED" ? body.decision : null;
  if (!decision) {
    return Response.json({ message: "Nieprawidłowa decyzja.", code: "LISTING_REVIEW_INVALID_DECISION" }, { status: 422 });
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : null;
  const supabase = createAdminClient();
  const { data, error } = await supabase.rpc("apply_listing_review_decision", {
    p_listing_id: listingId,
    p_decision: decision,
    p_reason: reason || null,
    p_now: new Date().toISOString(),
  });

  if (error) {
    const message = `${error.message ?? ""} ${error.details ?? ""}`;
    if (error.code === "P0002" || message.includes("LISTING_REVIEW_NOT_FOUND")) {
      return Response.json({ message: "Nie znaleziono oferty.", code: "LISTING_REVIEW_NOT_FOUND" }, { status: 404 });
    }
    if (error.code === "22023") {
      return Response.json({ message: "Nieprawidłowa decyzja.", code: "LISTING_REVIEW_INVALID_INPUT" }, { status: 422 });
    }
    if (error.code === "P0001") {
      return Response.json({ message: "Ta decyzja nie jest dozwolona w aktualnym stanie oferty.", code: "LISTING_REVIEW_INVALID_TRANSITION" }, { status: 409 });
    }
    console.error("LISTING REVIEW RPC ERROR:", { code: error.code });
    return Response.json({ message: "Nie udało się zapisać decyzji.", code: "LISTING_REVIEW_FAILED" }, { status: 500 });
  }

  const result = Array.isArray(data) ? data[0] : data;
  if (!result) {
    return Response.json({ message: "Nie udało się potwierdzić decyzji.", code: "LISTING_REVIEW_FAILED" }, { status: 500 });
  }

  return Response.json({
    ok: true,
    listingId,
    decision,
    lifecycleStatus: result.lifecycle_status,
    membershipCount: result.membership_count,
  });
}
