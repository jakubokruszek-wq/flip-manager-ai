import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { resolveDeterministicLocation } from "@/features/location-intelligence/deterministic-location";
import { buildResaleCandidates } from "@/features/transaction-prices/resales";
import { fetchRcnStreet, validQueryStreet } from "@/features/transaction-prices/wfs";
import { createClient } from "@/lib/supabase/server";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(_request: Request, { params }: { params: Promise<{ listingId: string }> }) {
  try { await requireOperator(); }
  catch (error) { return operatorAuthorizationResponse(error); }
  const { listingId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listingId)) return Response.json({ message: "Nie znaleziono oferty." }, { status: 404, headers });
  try {
    const db = await createClient();
    const found = await db.from("listings").select("id,city,district,address,title,description").eq("id", listingId).maybeSingle();
    if (found.error) throw new Error("LISTING_UNAVAILABLE");
    if (!found.data) return Response.json({ message: "Nie znaleziono oferty." }, { status: 404, headers });
    const row = found.data;
    const location = resolveDeterministicLocation({ city: row.city, district: row.district, address: row.address, title: row.title, description: row.description, street: null, locationText: row.address });
    const options = { now: new Date(), fetchedAt: new Date().toISOString(), truncated: false };
    const empty = buildResaleCandidates(location, [], options);
    if (["missing_location", "unsupported_location"].includes(empty.status)) return Response.json(empty, { headers });
    if (!location.street || !validQueryStreet(location.street)) return Response.json({ ...empty, status: "missing_location" }, { headers });
    const source = await fetchRcnStreet(location.street);
    return Response.json(buildResaleCandidates(location, source.rows, { ...options, fetchedAt: source.fetchedAt, truncated: source.truncated }), { headers });
  } catch {
    return Response.json({ message: "Historia odsprzedaży jest chwilowo niedostępna. Spróbuj ponownie później." }, { status: 503, headers });
  }
}
