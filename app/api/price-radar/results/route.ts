import { operatorAuthorizationResponse, requireOperator } from "@/features/auth/operator";
import { getRadarResults } from "@/features/price-radar/server/radar-results";
import { DEFAULT_RADAR_DISTRICTS, type RadarFilters, type RadarMarketFilter, type RadarSource } from "@/features/price-radar/types";
import { RADAR_SOURCES } from "@/features/price-radar/server/collect";

export async function GET(request: Request) {
  let operator;
  try {
    operator = await requireOperator();
  } catch (error) {
    return operatorAuthorizationResponse(error);
  }
  try {
    const url = new URL(request.url);
    const filters = parseFilters(url.searchParams);
    const payload = await getRadarResults(operator.id, filters);
    return Response.json({ ...payload, activeSources: RADAR_SOURCES, disabledSourceNote: "Źródła poza wspólną bramką Findera pozostają wyłączone w Radarze." });
  } catch (error) {
    console.error("PRICE RADAR RESULTS ROUTE ERROR:", error);
    return Response.json({ message: "Nie udało się pobrać wyników Radaru." }, { status: 500 });
  }
}

function parseFilters(searchParams: URLSearchParams): RadarFilters {
  const districtsParam = searchParams.getAll("district");
  const sourcesParam = searchParams.getAll("source");
  const roomsParam = searchParams.getAll("rooms");
  const market = searchParams.get("market");
  return {
    districts: districtsParam.length > 0 ? districtsParam : [...DEFAULT_RADAR_DISTRICTS],
    market: isMarketFilter(market) ? market : "both",
    areaMin: parsePositiveNumber(searchParams.get("areaMin")),
    areaMax: parsePositiveNumber(searchParams.get("areaMax")),
    minPricePerSqm: parsePositiveNumber(searchParams.get("minPricePerSqm")),
    rooms: roomsParam.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0),
    sources: sourcesParam.filter(isRadarSource),
  };
}

function isMarketFilter(value: string | null): value is RadarMarketFilter {
  return value === "secondary" || value === "primary" || value === "both";
}

function isRadarSource(value: string): value is RadarSource {
  return RADAR_SOURCES.includes(value as RadarSource);
}

function parsePositiveNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
