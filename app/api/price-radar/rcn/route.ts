import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { buildResaleCandidates } from "@/features/transaction-prices/resales";
import { normalizeRcnStreet } from "@/features/transaction-prices/model";
import { rcnSnapshot } from "@/features/transaction-prices/snapshot";
import { normalizeRcnLocation } from "@/features/transaction-prices/model";
import { fetchRcnStreet, validQueryStreet } from "@/features/transaction-prices/wfs";

const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request) {
  try { await requireOperator(); }
  catch (error) { return operatorAuthorizationResponse(error); }
  const rawStreet = new URL(request.url).searchParams.get("street") ?? "";
  const street = normalizeRcnStreet(rawStreet);
  if (!validQueryStreet(street) || /[!*?%]/.test(street)) return Response.json({ message: "Wpisz nazwę ulicy w Łodzi (2–100 znaków)." }, { status: 400, headers });
  try {
    if (new URL(request.url).searchParams.get("dataset") === "city") {
      const snapshot = rcnSnapshot();
      const rows = snapshot.candidates.filter(row => normalizeRcnLocation(row.street) === normalizeRcnLocation(street));
      return Response.json({ status: rows.length ? "ready" : "no_candidates", source: { title: "Rejestr Cen Nieruchomości — Łódź", url: snapshot.sourceUrl }, street, candidateCount: rows.length, strongCandidateCount: rows.length, rows, fetchedAt: snapshot.importedAt, truncated: false }, { headers });
    }
    const source = await fetchRcnStreet(street);
    return Response.json(buildResaleCandidates({ city: "Łódź", street }, source.rows, { now: new Date(), fetchedAt: source.fetchedAt, truncated: source.truncated }), { headers });
  } catch {
    return Response.json({ message: "Rejestr transakcji jest chwilowo niedostępny. Spróbuj ponownie później." }, { status: 503, headers });
  }
}
