import { RADAR_SOURCES } from "@/features/price-radar/server/collect";
import { DEFAULT_RADAR_DISTRICTS, type RadarFilters, type RadarSource } from "./types";

export const DEFAULT_RADAR_FILTERS: RadarFilters = {
  districts: [...DEFAULT_RADAR_DISTRICTS],
  market: "both",
  areaMin: null,
  areaMax: null,
  rooms: [],
  sources: [],
};

const DISTRICTS = new Set<string>(DEFAULT_RADAR_DISTRICTS);
const SOURCES = new Set<string>(RADAR_SOURCES);

export function normalizeRadarFilters(value: unknown): RadarFilters {
  const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const districts = Array.isArray(object.districts) ? [...new Set(object.districts.filter((item): item is string => typeof item === "string" && DISTRICTS.has(item)))] : [...DEFAULT_RADAR_FILTERS.districts];
  const sources = Array.isArray(object.sources) ? [...new Set(object.sources.filter((item): item is RadarSource => typeof item === "string" && SOURCES.has(item)))] : [];
  const rooms = Array.isArray(object.rooms) ? [...new Set(object.rooms.filter((item): item is number => Number.isInteger(item) && item >= 1 && item <= 10))] : [];
  const market = object.market === "primary" || object.market === "secondary" ? object.market : "both";
  const areaMin = finitePositiveOrNull(object.areaMin);
  const areaMax = finitePositiveOrNull(object.areaMax);
  return { districts: districts.length ? districts : [...DEFAULT_RADAR_FILTERS.districts], market, areaMin, areaMax, rooms, sources };
}

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1000 ? value : null;
}
