import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { DEFAULT_RADAR_DISTRICTS, type RadarQualityCategory, type RadarVerificationDecision } from "@/features/price-radar/types";
import { resolveRadarVerificationCandidate } from "@/features/price-radar/server/radar-verification-queue";

export async function POST(request: Request) {
  let operator;
  try { operator = await requireOperator(); } catch (error) { return operatorAuthorizationResponse(error); }
  try {
    const body = await request.json() as Record<string, unknown>;
    const decision = parseDecision(body.decision);
    if (typeof body.queueId !== "string" || !body.queueId || !decision) {
      return Response.json({ message: "Uzupełnij potwierdzenie mieszkania na sprzedaż, cenę, metraż, dzielnicę, budynek, rynek i standard." }, { status: 400 });
    }
    const result = await resolveRadarVerificationCandidate(operator.id, body.queueId, decision);
    if (!result.ok) {
      if (result.reason === "schema_unavailable") return Response.json({ message: "Kolejka weryfikacji wymaga migracji bazy." }, { status: 503 });
      if (result.reason === "not_found") return Response.json({ message: "Nie znaleziono oczekującej oferty do weryfikacji." }, { status: 404 });
      if (result.reason === "no_longer_qualifies") return Response.json({ message: "Oferta po ponownej kwalifikacji nie spełnia kryteriów Radaru.", reason: result.detail }, { status: 409 });
      return Response.json({ message: "Nieprawidłowe dane operatora." }, { status: 400 });
    }
    return Response.json({ ok: true, listingId: result.listingId });
  } catch (error) {
    console.error("PRICE RADAR VERIFICATION RESOLVE ERROR:", error);
    return Response.json({ message: "Nie udało się zatwierdzić oferty do porównań." }, { status: 500 });
  }
}

function parseDecision(value: unknown): RadarVerificationDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.apartmentSaleConfirmed !== true || record.city !== "Łódź") return null;
  const price = finitePositive(record.price);
  const area = finitePositive(record.area);
  const rooms = finitePositive(record.rooms);
  if (price === null || area === null || rooms === null || !Number.isInteger(rooms)) return null;
  if (typeof record.district !== "string" || !(DEFAULT_RADAR_DISTRICTS as readonly string[]).includes(record.district)) return null;
  if (record.buildingType !== "blok" && record.buildingType !== "apartamentowiec") return null;
  if (record.marketType !== "primary" && record.marketType !== "secondary") return null;
  if (record.qualityCategory !== "fresh_renovation" && record.qualityCategory !== "ready_high_standard") return null;
  return { apartmentSaleConfirmed: true, price, area, rooms, city: "Łódź", district: record.district as RadarVerificationDecision["district"], buildingType: record.buildingType, marketType: record.marketType, qualityCategory: record.qualityCategory as RadarQualityCategory };
}

function finitePositive(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
