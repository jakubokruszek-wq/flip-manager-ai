import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { resolveDeterministicLocation } from "@/features/location-intelligence/deterministic-location";
import { buildTransactionComparison } from "@/features/transaction-prices/model";
import { fetchRcnStreet, validQueryStreet } from "@/features/transaction-prices/wfs";
import type { RcnMarket, RcnSubject } from "@/features/transaction-prices/types";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ listingId: string }> };
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request, { params }: Context) {
  try { await requireOperator(); }
  catch (error) { return operatorAuthorizationResponse(error); }

  const marketValue = new URL(request.url).searchParams.get("market") ?? "secondary";
  if (marketValue !== "secondary" && marketValue !== "primary") return Response.json({ message: "Wybierz rynek wtórny lub pierwotny." }, { status: 400, headers });
  const market: RcnMarket = marketValue;
  const { listingId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(listingId)) return Response.json({ message: "Nie znaleziono oferty." }, { status: 404, headers });

  try {
    const supabase = await createClient();
    const result = await supabase.from("listings").select("id,city,district,address,title,description,area,price").eq("id", listingId).maybeSingle();
    if (result.error) return Response.json({ message: "Nie udało się pobrać oferty." }, { status: 503, headers });
    const row = result.data;
    if (!row) return Response.json({ message: "Nie znaleziono oferty." }, { status: 404, headers });
    const location = resolveDeterministicLocation({ city: row.city, district: row.district, address: row.address, title: row.title, description: row.description, street: null, locationText: row.address });
    const subject: RcnSubject = { city: location.city, street: location.street, area: finitePositive(row.area), price: finitePositive(row.price) };
    const now = new Date();
    const options = { market, now, fetchedAt: now.toISOString(), truncated: false };
    const empty = buildTransactionComparison(subject, [], options);
    if (empty.status === "missing_location" || empty.status === "unsupported_location" || empty.status === "missing_area") return Response.json(empty, { headers });
    if (!subject.street || !validQueryStreet(subject.street)) return Response.json({ ...empty, status: "missing_location" }, { headers });
    const source = await fetchRcnStreet(subject.street);
    return Response.json(buildTransactionComparison(subject, source.rows, { ...options, fetchedAt: source.fetchedAt, truncated: source.truncated }), { headers });
  } catch {
    // Source outages must not change the offer or its existing investment analysis.
    return Response.json({ message: "Dane transakcyjne RCN są chwilowo niedostępne. Spróbuj ponownie później." }, { status: 503, headers });
  }
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
