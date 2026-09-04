import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context): Promise<Response> {
  const listingId = (await params).id;
  if (!/^[0-9a-f-]{20,}$/i.test(listingId)) return Response.json({ message: "Nieprawidłowa oferta." }, { status: 400 });
  const body = await request.json().catch(() => null) as { decision?: unknown; reason?: unknown } | null;
  const decision = body?.decision === "ACCEPTED" || body?.decision === "REJECTED" ? body.decision : null;
  if (!decision) return Response.json({ message: "Nieprawidłowa decyzja." }, { status: 400 });
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : null;
  const supabase = await createClient();
  const values = decision === "ACCEPTED"
    ? { lifecycle_status: "ACTIVE", manual_decision: "ACCEPTED", manual_decision_reason: reason, archived_at: null, status: "active" }
    : { lifecycle_status: "REJECTED", manual_decision: "REJECTED", manual_decision_reason: reason, archived_at: new Date().toISOString() };
  const { data, error } = await supabase.from("listings").update(values).eq("id", listingId).select("id").maybeSingle();
  if (error) return Response.json({ message: "Nie udało się zapisać decyzji." }, { status: 500 });
  if (!data) return Response.json({ message: "Nie znaleziono oferty." }, { status: 404 });
  if (decision === "REJECTED") {
    await supabase.from("listing_filter_matches").update({ is_current_match: false }).eq("listing_id", listingId);
  } else {
    const { data: matches } = await supabase.from("listing_filter_matches").select("search_filter_id,match_reasons").eq("listing_id", listingId);
    for (const match of matches ?? []) {
      const reasons = Array.isArray(match.match_reasons) ? match.match_reasons.filter((value): value is string => typeof value === "string" && value !== "review" && !value.startsWith("unknown_")) : [];
      await supabase.from("listing_filter_matches").update({ is_current_match: true, last_matched_at: new Date().toISOString(), match_reasons: [...new Set(["manual_accept", ...reasons])] }).eq("listing_id", listingId).eq("search_filter_id", match.search_filter_id);
    }
  }
  return Response.json({ ok: true, listingId, decision });
}
