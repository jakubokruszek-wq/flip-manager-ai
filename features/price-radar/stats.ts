import { MIN_RADAR_SAMPLE_SIZE, type RadarStatGroup } from "./types";
import type { MarketType } from "@/features/flip-finder";

export type StatInputListing = {
  district: string;
  marketType: MarketType;
  pricePerSqm: number;
  lastSeenAt: string;
  status: "active" | "removed";
  excludedAt: string | null;
};

/**
 * Groups by (district, marketType) and never mixes markets into one average
 * -- "Oba" (both) is a UI selection that simply shows every group, not a
 * combined one. Excluded and removed listings never enter the sample. A
 * group below MIN_RADAR_SAMPLE_SIZE is still returned (never hidden) but
 * flagged isSmallSample, so the UI can show the true count but no reference
 * price until the minimum sample threshold is reached.
 */
export function computeRadarStats(listings: StatInputListing[]): RadarStatGroup[] {
  const groups = new Map<string, StatInputListing[]>();
  for (const listing of listings) {
    if (listing.status !== "active" || listing.excludedAt !== null) continue;
    const key = `${listing.district}::${listing.marketType}`;
    const group = groups.get(key) ?? [];
    group.push(listing);
    groups.set(key, group);
  }

  const result: RadarStatGroup[] = [];
  for (const [key, group] of groups) {
    const [district, marketType] = key.split("::") as [string, MarketType];
    const values = group.map((item) => item.pricePerSqm).sort((left, right) => left - right);
    const sampleSize = values.length;
    const updatedAt = group.reduce<string | null>((latest, item) => (!latest || item.lastSeenAt > latest ? item.lastSeenAt : latest), null);
    result.push({
      district,
      marketType,
      averagePricePerSqm: sampleSize >= MIN_RADAR_SAMPLE_SIZE ? values.reduce((sum, value) => sum + value, 0) / sampleSize : null,
      medianPricePerSqm: sampleSize >= MIN_RADAR_SAMPLE_SIZE ? median(values) : null,
      sampleSize,
      isSmallSample: sampleSize < MIN_RADAR_SAMPLE_SIZE,
      updatedAt,
    });
  }
  return result.sort((left, right) => left.district.localeCompare(right.district, "pl") || left.marketType.localeCompare(right.marketType));
}

function median(sortedValues: number[]): number {
  const mid = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0 ? (sortedValues[mid - 1] + sortedValues[mid]) / 2 : sortedValues[mid];
}

export function statGroupFor(groups: RadarStatGroup[], district: string, marketType: MarketType): RadarStatGroup | null {
  return groups.find((group) => group.district === district && group.marketType === marketType) ?? null;
}
